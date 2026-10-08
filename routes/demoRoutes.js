// Deliberately separate from production: in-memory sample records; no database or CRM writes.
const express = require('express');
const multer = require('multer');
const m = require('../services/contactReviewMatching');
const readCsv = require('../services/csvImport');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
let seq = 100;
const companies = [
  { _id: 'c1', key: 'northstar technologies', name: 'Northstar Technologies', decision: 'pending' },
  { _id: 'c2', key: 'meridian healthcare', name: 'Meridian Healthcare', decision: 'pending' },
  { _id: 'c3', key: 'atlas logistics', name: 'Atlas Logistics', decision: 'existing', crmLeadId: 'l3' },
  { _id: 'c4', key: 'bluebird retail', name: 'Bluebird Retail', decision: 'pending' }
];
const leads = [
  { _id: 'l1', company_name: 'Northstar Technologies Pvt. Ltd.', website_url: 'https://northstar.example', stage: 'Contacted', status: 'approved', points_of_contact: [{ _id: 'p1', name: 'Priya Sharma', email: 'priya@northstar.example', phone: '9876543210' }] },
  { _id: 'l2', company_name: 'North Star Technology Services', website_url: 'https://northstarservices.example', stage: 'New', status: 'approved', points_of_contact: [] },
  { _id: 'l3', company_name: 'Atlas Logistics', website_url: 'https://atlas.example', stage: 'Proposal Sent', status: 'approved', points_of_contact: [] }
];
const contacts = [
  { _id: 'r1', companyKey: companies[0].key, company_name: companies[0].name, name: 'Priya Sharma', designation: 'HR Director', email: 'priya@northstar.example', phone: '+91 98765 43210', status: 'pending' },
  { _id: 'r2', companyKey: companies[0].key, company_name: companies[0].name, name: 'Arjun Mehta', designation: 'Talent Acquisition Manager', email: 'arjun@northstar.example', phone: '9123456780', status: 'pending' },
  { _id: 'r3', companyKey: companies[0].key, company_name: companies[0].name, name: 'Neha Rao', designation: 'People Operations', email: 'neha@northstar.example', phone: '9988776655', status: 'pending' },
  { _id: 'r4', companyKey: companies[1].key, company_name: companies[1].name, name: 'Vikram Singh', designation: 'Recruitment Lead', email: 'vikram@meridian.example', phone: '9000012345', status: 'pending' },
  { _id: 'r5', companyKey: companies[2].key, company_name: companies[2].name, name: 'Ananya Iyer', designation: 'HR Manager', email: 'ananya@atlas.example', phone: '9000067890', status: 'pending' },
  { _id: 'r6', companyKey: companies[3].key, company_name: companies[3].name, name: 'Karan Patel', designation: 'Head of People', email: 'karan@bluebird.example', phone: '', status: 'pending' }
];
router.get('/companies', (req, res) => {
  const filtered = companies.filter(c => (!req.query.search || c.name.toLowerCase().includes(req.query.search.toLowerCase())) && (!req.query.status || c.decision === req.query.status));
  const page = Math.max(1, Number(req.query.page) || 1);
  res.json({ companies: filtered.slice((page - 1) * 40, page * 40).map(c => ({ ...c, counts: { total: contacts.filter(p => p.companyKey === c.key).length, remaining: contacts.filter(p => p.companyKey === c.key && ['pending', 'duplicate'].includes(p.status)).length } })), total: filtered.length, page, stats: Object.fromEntries(['pending', 'duplicate', 'transferred', 'skipped'].map(s => [s, contacts.filter(c => c.status === s).length])) });
});
router.get('/companies/:id', (req, res) => {
  const company = companies.find(c => c._id === req.params.id); if (!company) return res.status(404).json({ message: 'Company not found.' });
  const crm = leads.flatMap(l => l.points_of_contact.map(p => ({ ...p, leadId: l._id, company_name: l.company_name })));
  const contactPage = Math.max(1, Math.floor(Number(req.query.contactPage) || 1)), companyContacts = contacts.filter(c => c.companyKey === company.key);
  res.json({ company, contactPage, totalContacts: companyContacts.length, crmConnected: true, candidates: m.candidates(company.name, leads.map(({ points_of_contact, ...l }) => l)), selectedLead: leads.find(l => l._id === company.crmLeadId) || null,
    contacts: companyContacts.slice((contactPage - 1) * 100, contactPage * 100).map(c => ({ ...c, duplicates: [...crm.filter(p => p._id !== c._id && m.duplicateReason(c, p)).map(p => ({ source: 'CRM', reason: m.duplicateReason(c, p), name: p.name, company_name: p.company_name })), ...contacts.filter(p => p._id !== c._id && m.duplicateReason(c, p)).map(p => ({ source: 'Import', reason: m.duplicateReason(c, p), name: p.name, company_name: p.company_name }))] })) });
});
router.get('/crm-search', (req, res) => res.json(m.candidates(req.query.name, leads.map(({ points_of_contact, ...l }) => l))));
router.put('/companies/:id', (req, res) => {
  const c = companies.find(c => c._id === req.params.id); if (!c) return res.status(404).json({ message: 'Company not found.' });
  try { c.verifiedWebsite = m.website(req.body.website); } catch(e) { return res.status(400).json({ message: e.message }); }
  c.decision = req.body.decision; c.crmLeadId = req.body.crmLeadId; res.json(c);
});
router.patch('/contacts/:id', (req, res) => { const c = contacts.find(c => c._id === req.params.id); if (!c) return res.status(404).json({ message: 'Contact not found.' }); c.status = req.body.status; res.json(c); });
router.post('/import/preview', upload.single('file'), async (req, res) => { if (!req.file) return res.status(400).json({ message: 'Choose a CSV file.' }); const data = await readCsv(req.file.buffer); res.json({ headers: data.headers, count: data.rows.length, sample: data.rows.slice(0, 5) }); });
router.post('/import', upload.single('file'), async (req, res) => {
  const { rows } = await readCsv(req.file.buffer), mapping = JSON.parse(req.body.mapping); let inserted = 0, alreadyImported = 0, invalidCount = 0;
  for (const raw of rows) {
    const row = Object.fromEntries(['company_name', 'name', 'email', 'phone', 'designation', 'linkedin_url'].map(f => [f, m.clean(raw[mapping[f]])]));
    if (!row.company_name || !(row.name || row.email || row.phone)) { invalidCount++; continue; }
    if (contacts.some(c => m.fingerprint(c) === m.fingerprint(row))) { alreadyImported++; continue; }
    const key = m.companyKey(row.company_name);
    if (!companies.some(c => c.key === key)) companies.push({ _id: `c${seq++}`, key, name: row.company_name, decision: 'pending' });
    contacts.push({ ...row, _id: `r${seq++}`, companyKey: key, status: 'pending' }); inserted++;
  }
  res.json({ inserted, alreadyImported, invalidCount, invalid: [] });
});
router.post('/transfer', (req, res) => {
  const results = [];
  for (const contactId of req.body.contactIds || []) {
    const c = contacts.find(x => x._id === contactId), company = c && companies.find(x => x.key === c.companyKey);
    if (!c || !company || company.decision === 'pending') { results.push({ id: contactId, status: 'error', message: 'Confirm the company first.' }); continue; }
    if (c.status === 'transferred') { results.push({ id: contactId, status: 'transferred', alreadyTransferred: true }); continue; }
    if (leads.some(l => l.points_of_contact.some(p => m.duplicateReason(c, p)))) { c.status = 'duplicate'; results.push({ id: contactId, status: 'duplicate', message: 'Email or phone already exists in CRM.' }); continue; }
    if (company.decision === 'new' && !company.verifiedWebsite) { results.push({ id: contactId, status: 'error', message: 'Verify the company website first.' }); continue; }
    let lead = leads.find(l => l._id === company.crmLeadId);
    if (!lead) { lead = { _id: `l${seq++}`, company_name: company.name, website_url: company.verifiedWebsite, stage: 'New', status: 'approved', points_of_contact: [] }; leads.push(lead); company.crmLeadId = lead._id; company.decision = 'existing'; }
    lead.points_of_contact.push({ ...c }); c.status = 'transferred'; results.push({ id: contactId, status: 'transferred' });
  }
  res.json({ results });
});
module.exports = router;
