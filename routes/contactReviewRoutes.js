const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const auth = require('../middleware/authMiddleware');
const { connection: crmConnection, ensureConnected, isConfigured } = require('../services/crmConnection');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const getModels = require('../models/contactReviewModels');
const m = require('../services/contactReviewMatching');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const fail = (status, message) => Object.assign(new Error(message), { status });
const id = value => { if (!mongoose.isValidObjectId(value)) throw fail(400, 'Invalid record ID.'); return value; };
router.use(auth);
const audit = require('../services/teamAudit');
router.use((req, res, next) => req.path.startsWith('/import') && req.user.role !== 'admin' ? res.status(403).json({ message: 'Only administrators can import contact lists.' }) : next());
const readCsv = require('../services/csvImport');
const getCrmLeads = async () => {
  if (!isConfigured()) return [];
  await ensureConnected();
  return Lead.find({}).select('company_name website_url stage status points_of_contact').lean();
};
router.post('/import/preview', upload.single('file'), async (req, res) => {
  if (!req.file) throw fail(400, 'Choose a CSV file.');
  const parsed = await readCsv(req.file.buffer);
  res.json({ headers: parsed.headers, count: parsed.rows.length, sample: parsed.rows.slice(0, 5) });
});
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) throw fail(400, 'Choose a CSV file.');
  let mapping; try { mapping = JSON.parse(req.body.mapping); } catch { throw fail(400, 'Choose the CSV column mapping.'); }
  const { rows, headers } = await readCsv(req.file.buffer);
  if (!mapping.company_name || !headers.includes(mapping.company_name)) throw fail(400, 'Map the company name column.');
  const fields = ['company_name', 'name', 'email', 'phone', 'alternate_phone', 'designation', 'linkedin_url'];
  for (const field of fields) if (mapping[field] && !headers.includes(mapping[field])) throw fail(400, `Unknown column for ${field}.`);
  const { Contact, Company } = await getModels();
  const records = [], invalid = [], companies = new Map();
  rows.forEach((raw, index) => {
    const row = Object.fromEntries(fields.map(field => [field, m.clean(raw[mapping[field]]).slice(0, 500)]));
    if (!row.company_name || !(row.name || row.email || row.phone)) { invalid.push({ row: index + 2, reason: 'Company and at least one contact identifier are required.' }); return; }
    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) { invalid.push({ row: index + 2, reason: 'Invalid email address.' }); return; }
    row.companyKey = m.companyKey(row.company_name);
    if (!row.companyKey) { invalid.push({ row: index + 2, reason: 'Company name must contain letters or numbers.' }); return; }
    if (row.phone && m.phoneKey(row.phone).length < 7) { invalid.push({ row: index + 2, reason: 'Phone number is too short.' }); return; }
    if (row.alternate_phone && m.phoneKey(row.alternate_phone).length < 7) { invalid.push({ row: index + 2, reason: 'Alternative phone number is too short.' }); return; }
    const phones = m.uniquePhones([row, ...['Source Phone', 'Source Mobile Phone', 'Source WhatsApp Phone'].map(header => ({ phone: m.clean(raw[header]) })).filter(r => m.phoneKey(r.phone).length >= 7)]);
    row.phone = phones[0] || ''; row.alternate_phone = phones[1] || ''; row.additionalPhones = phones.slice(2); row.phoneKeys = phones.map(m.phoneKey);
    row.sourceKey = m.fingerprint(row); row.emailKey = m.emailKey(row.email); row.phoneKey = m.phoneKey(row.phone); row.importedBy = req.user.id;
    records.push(row); companies.set(row.companyKey, row.company_name);
  });
  if (!records.length) throw fail(400, `No valid contacts. ${invalid.length} invalid rows.`);
  await Company.bulkWrite([...companies].map(([key, name]) => ({ updateOne: { filter: { key }, update: { $setOnInsert: { key, name, decision: 'pending' } }, upsert: true } })));
  let inserted = 0;
  for (let offset = 0; offset < records.length; offset += 500) {
    const result = await Contact.bulkWrite(records.slice(offset, offset + 500).map(row => ({ updateOne: { filter: { sourceKey: row.sourceKey }, update: { $setOnInsert: row }, upsert: true } })));
    inserted += result.upsertedCount;
  }
  const savedSources = await Contact.find({ sourceKey: { $in: records.map(row => row.sourceKey) } }).select('sourceKey mergedInto').lean();
  const savedByKey = new Map(savedSources.map(row => [row.sourceKey, row]));
  const numberUpdates = records.map(row => {
    const source = savedByKey.get(row.sourceKey);
    return { updateOne: { filter: { _id: source.mergedInto || source._id, status: { $ne: 'transferred' } }, update: { $addToSet: { additionalPhones: { $each: m.contactPhones(row) } } } } };
  });
  for (let start = 0; start < numberUpdates.length; start += 500) await Contact.bulkWrite(numberUpdates.slice(start, start + 500));
  const consolidated = await require('../services/consolidateReviewContacts')(Contact);
  res.json({ inserted, alreadyImported: records.length - inserted, merged: consolidated.merged, visibleContacts: consolidated.visibleContacts, invalidCount: invalid.length, invalid: invalid.slice(0, 100) });
});
router.get('/companies', async (req, res) => {
  const { Company, Contact } = await getModels();
  const search = m.clean(req.query.search).slice(0, 150), page = Math.max(1, Number(req.query.page) || 1);
  const query = search ? { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {};
  if (req.query.status === 'existing_crm') query.$or = [{ decision: 'existing' }, { reviewStatus: 'existing_crm' }];
  else if (['no_hiring', 'verify_later', 'another_company'].includes(req.query.status)) query.reviewStatus = req.query.status;
  else if (['pending', 'existing', 'new'].includes(req.query.status)) { query.decision = req.query.status; query.reviewStatus = { $nin: ['no_hiring', 'verify_later', 'another_company', 'existing_crm'] }; }
  const [companies, total, stats] = await Promise.all([
    Company.find(query).sort({ name: 1 }).skip((page - 1) * 40).limit(40).lean(), Company.countDocuments(query),
    Contact.aggregate([{ $match: { mergedInto: null } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
  ]);
  const counts = await Contact.aggregate([{ $match: { mergedInto: null, companyKey: { $in: companies.map(x => x.key) } } }, { $group: { _id: '$companyKey', total: { $sum: 1 }, remaining: { $sum: { $cond: [{ $in: ['$status', ['pending', 'duplicate']] }, 1, 0] } } } }]);
  res.json({ companies: companies.map(x => ({ ...x, counts: counts.find(c => c._id === x.key) || { total: 0, remaining: 0 } })), total, page, stats: Object.fromEntries(stats.map(x => [x._id, x.count])) });
});
const crmContacts = leads => leads.flatMap(lead => (lead.points_of_contact || []).map(poc => ({ ...poc, leadId: lead._id, company_name: lead.company_name })));
router.get('/companies/:id', async (req, res) => {
  const { Company, Contact } = await getModels();
  const company = await Company.findById(id(req.params.id)).lean(); if (!company) throw fail(404, 'Company not found.');
  const contactPage = Math.max(1, Math.floor(Number(req.query.contactPage) || 1));
  const [contacts, leads, totalContacts] = await Promise.all([Contact.find({ companyKey: company.key, mergedInto: null }).sort({ name: 1, _id: 1 }).skip((contactPage - 1) * 100).limit(100).lean(), getCrmLeads(), Contact.countDocuments({ companyKey: company.key, mergedInto: null })]);
  const crm = crmContacts(leads);
  const emails = [...new Set(contacts.map(c => c.emailKey).filter(Boolean))], phones = [...new Set(contacts.flatMap(c => m.contactPhones(c).map(m.phoneKey)))];
  const staging = emails.length || phones.length ? await Contact.find({ mergedInto: null, $or: [{ emailKey: { $in: emails } }, { phoneKey: { $in: phones } }, { phoneKeys: { $in: phones } }] }).select('name email phone alternate_phone additionalPhones company_name').lean() : [];
  const matching = m.candidates(company.name, leads.map(({ points_of_contact, ...lead }) => lead));
  const selectedLead = leads.find(x => String(x._id) === String(company.crmLeadId));
  res.json({ company, totalContacts, contactPage, crmConnected: isConfigured(), candidates: matching, selectedLead: selectedLead ? { _id: selectedLead._id, company_name: selectedLead.company_name, website_url: selectedLead.website_url, stage: selectedLead.stage, status: selectedLead.status } : null,
    contacts: contacts.map(c => ({ ...c, duplicates: [
      ...crm.filter(p => String(p._id) !== String(c._id) && m.duplicateReason(c, p)).map(p => ({ source: 'CRM', reason: m.duplicateReason(c, p), name: p.name, company_name: p.company_name, leadId: p.leadId, contactId: p._id })),
      ...staging.filter(p => String(p._id) !== String(c._id) && m.duplicateReason(c, p)).map(p => ({ source: 'Import', reason: m.duplicateReason(c, p), name: p.name, company_name: p.company_name }))
    ].slice(0, 20) })) });
});
router.get('/crm-users', async (req, res) => {
  await ensureConnected();
  const users = await crmConnection.collection('users').find({ status: 'Active' }, { projection: { name: 1, email: 1, role: 1 } }).sort({ name: 1 }).toArray();
  res.json(users);
});
router.get('/crm-search', async (req, res) => {
  const name = m.clean(req.query.name).slice(0, 150); if (!name) return res.json([]);
  const leads = await getCrmLeads();
  res.json(m.candidates(name, leads.map(({ points_of_contact, ...lead }) => lead)));
});
router.patch('/companies/:id/review-status', async (req, res) => {
  if (!['pending', 'no_hiring', 'verify_later', 'another_company', 'existing_crm'].includes(req.body.reviewStatus)) throw fail(400, 'Choose a valid company review status.');
  const { Company } = await getModels();
  const company = await Company.findByIdAndUpdate(id(req.params.id), { $set: { reviewStatus: req.body.reviewStatus } }, { new: true, runValidators: true });
  if (!company) throw fail(404, 'Company not found.');
  await audit(req.user, 'company_status', company._id, company.name, req.body.reviewStatus);
  res.json(company);
});
router.put('/companies/:id', async (req, res) => {
  const { Company } = await getModels(); const company = await Company.findById(id(req.params.id));
  if (!company) throw fail(404, 'Company not found.');
  if (!['pending', 'existing', 'new'].includes(req.body.decision)) throw fail(400, 'Choose a company decision.');
  if (req.body.ownerId) {
    await ensureConnected();
    if (!await crmConnection.collection('users').findOne({ _id: new mongoose.Types.ObjectId(id(req.body.ownerId)), status: 'Active' })) throw fail(400, 'Select an active CRM user.');
  }
  if (Object.hasOwn(req.body, 'ownerId')) company.ownerId = req.body.ownerId || undefined;
  if (Object.hasOwn(req.body, 'industryName')) company.industryName = m.clean(req.body.industryName).slice(0,200);
  let url; try { url = m.website(req.body.website); } catch (e) { throw fail(400, e.message); }
  if (req.body.decision === 'existing') {
    await ensureConnected();
    const lead = await Lead.findById(id(req.body.crmLeadId)); if (!lead) throw fail(404, 'CRM company not found.');
    if (req.body.updateCrmWebsite) { if (!url) throw fail(400, 'Enter the verified website first.'); lead.website_url = url; await lead.save(); }
    company.crmLeadId = lead._id;
  } else company.crmLeadId = undefined;
  company.decision = req.body.decision; company.verifiedWebsite = url; company.reviewedBy = req.user.id;
  await company.save(); await audit(req.user, 'company_review', company._id, company.name, company.decision); res.json(company);
});
router.patch('/contacts/:id', async (req, res) => {
  const { Contact } = await getModels(); const contact = await Contact.findById(id(req.params.id));
  if (!contact) throw fail(404, 'Contact not found.');
  if (contact.mergedInto) throw fail(409, 'This record was combined with another contact. Refresh the company.');
  if (contact.status === 'transferred') throw fail(409, 'Transferred contacts must be edited in the CRM.');
  if (Object.hasOwn(req.body, 'destinationName')) {
    const name = m.clean(req.body.destinationName).slice(0, 200);
    let website; try { website = m.website(req.body.destinationWebsite); } catch(e) { throw fail(400, e.message); }
    if (name && (!m.companyKey(name) || !website)) throw fail(400, 'A new company needs a name and verified website.');
    if (req.body.ownerId) {
      await ensureConnected();
      if (!await crmConnection.collection('users').findOne({ _id: new mongoose.Types.ObjectId(id(req.body.ownerId)), status: 'Active' })) throw fail(400, 'Select an active CRM user.');
    }
    contact.destinationName = name; contact.destinationWebsite = name ? website : '';
    contact.ownerId = req.body.ownerId || undefined;
    await contact.save(); await audit(req.user, 'contact_destination', contact._id, contact.company_name, (contact.destinationName || 'Shared company decision') + (contact.ownerId ? ' · CRM owner ID: ' + contact.ownerId : ' · Default CRM owner')); return res.json(contact);
  }
  if (!['pending', 'skipped'].includes(req.body.status)) throw fail(400, 'Choose pending or skipped.');
  const changed = contact.status !== req.body.status;
  contact.status = req.body.status; await contact.save(); if (changed) await audit(req.user, contact.status === 'skipped' ? 'contact_skipped' : 'contact_restored', contact._id, contact.company_name); res.json(contact);
});
// Serialize staging transfers across app processes. The lock write participates in the CRM transaction.
const lockSchema = new mongoose.Schema({ _id: String, revision: Number });
const Lock = crmConnection.model('ContactReviewLock', lockSchema);
const transfer = async (contactId, user) => {
  await ensureConnected();
  const actor = { ...user };
  // Explicitly attribute every CRM write to an existing active CRM administrator.
  const admin = await crmConnection.collection('users').findOne({ email: process.env.REVIEW_ADMIN_EMAIL.toLowerCase(), role: 'Admin', status: 'Active' }, { projection: { _id: 1, name: 1 } });
  if (!admin) throw fail(403, 'Use the email address of an active CRM administrator in REVIEW_ADMIN_EMAIL before transferring.');
  user = { ...user, id: admin._id, name: actor.role === 'member' ? actor.name : admin.name };
  if (actor.role !== 'member') actor.name = admin.name;
  const { Contact, Company } = await getModels();
  const contact = await Contact.findById(id(contactId)); if (!contact) throw fail(404, 'Contact not found.');
  if (contact.mergedInto) throw fail(409, 'This record was combined with another contact. Refresh the company.');
  if (contact.status === 'transferred') return { id: contactId, status: 'transferred', alreadyTransferred: true };
  if (contact.status === 'skipped') throw fail(409, 'Restore this contact before moving it.');
  const sourceCompany = await Company.findOne({ key: contact.companyKey });
  const company = contact.destinationName ? { name: contact.destinationName, verifiedWebsite: contact.destinationWebsite, decision: 'new' } : sourceCompany;
  const ownerId = contact.ownerId || (!contact.destinationName && company?.ownerId) || user.id;
  if (!await crmConnection.collection('users').findOne({ _id: new mongoose.Types.ObjectId(ownerId), status: 'Active' })) throw fail(409, 'The selected owner is no longer active. Choose another user.');
  if (!company || company.decision === 'pending') throw fail(409, 'Confirm the company match first.');
  try { await Lock.updateOne({ _id: 'transfer' }, { $setOnInsert: { revision: 0 } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
  let result;
  await crmConnection.transaction(async session => {
    await Lock.updateOne({ _id: 'transfer' }, { $inc: { revision: 1 } }, { session });
    const leads = await Lead.find({}).session(session);
    // Deterministic POC ID makes retries safe even if saving staging status failed after a CRM commit.
    const prior = leads.find(l => l.points_of_contact.some(p => String(p._id) === String(contact._id)));
    if (prior) { result = { id: contactId, status: 'transferred', leadId: prior._id, contactId: contact._id }; return; }
    const duplicates = crmContacts(leads.map(l => l.toObject())).filter(p => m.duplicateReason(contact, p));
    if (duplicates.length) { result = { id: contactId, status: 'duplicate', message: 'Email or phone already exists in CRM. Review before moving.', matches: duplicates.map(p => ({ name: p.name, company_name: p.company_name, leadId: p.leadId, contactId: p._id, reason: m.duplicateReason(contact, p) })) }; return; }
    let lead;
    if (company.decision === 'existing') {
      lead = leads.find(l => String(l._id) === String(company.crmLeadId));
      if (!lead) throw fail(409, 'The selected CRM company no longer exists. Review the mapping again.');
    } else {
      if (!company.verifiedWebsite) throw fail(409, 'Verify a website before creating a new company.');
      const exact = leads.filter(l => m.matchName(l.company_name) === m.matchName(company.name) || (l.website_url && (() => { try { return m.website(l.website_url) === company.verifiedWebsite; } catch { return false; } })()));
      if (contact.destinationName && exact.length === 1 && exact[0].contactReviewDestination === true && m.matchName(exact[0].company_name) === m.matchName(company.name) && (() => { try { return m.website(exact[0].website_url) === company.verifiedWebsite; } catch { return false; } })()) lead = exact[0];
      else if (exact.length) throw fail(409, `Company name or website already exists in CRM: ${exact.map(l => l.company_name).join('; ')}. Search CRM and confirm the correct company, save the company decision, then retry. No contact was moved.`);
      if (!lead) {
      lead = new Lead({ company_name: company.name, website_url: company.verifiedWebsite, industry_name: company.industryName || '', assignedBy: ownerId, createdBy: user.id, assignedTo: [ownerId], status: 'approved', lead_source: 'Contact review', contactReviewDestination: Boolean(contact.destinationName), points_of_contact: [] });
      await lead.save({ session });
      await LeadActivity.create([{ leadId: lead._id, type: 'Lead Created', description: 'Company created from reviewed contact import.', performedBy: user.id, performedByName: user.name }], { session });
    }
    }
    lead.stage = 'New';
    lead.points_of_contact.push({ _id: contact._id, name: contact.name, email: contact.email, phone: contact.phone, alternate_phone: contact.alternate_phone || '', additionalPhones: contact.additionalPhones || [], designation: contact.designation, linkedin_url: contact.linkedin_url, stage: 'New', approvalStatus: lead.status === 'incomplete' ? 'pending' : 'approved', createdBy: user.id });
    if (contact.ownerId || (!contact.destinationName && company.ownerId)) {
      lead.assignedBy = ownerId;
      if (!lead.assignedTo.some(value => String(value) === String(ownerId))) lead.assignedTo.push(ownerId);
    }
    await lead.save({ session });
    await LeadActivity.create([{ leadId: lead._id, type: 'POC Added', description: `Imported reviewed contact: ${contact.name || contact.email || contact.phone}`, performedBy: user.id, performedByName: user.name, metadata: { pocId: contact._id, reviewContactId: contact._id, reviewActorId: String(actor.id || 'administrator'), reviewActorName: actor.name } }], { session });
    result = { id: contactId, status: 'transferred', leadId: lead._id, contactId: contact._id };
  });
  if (result.status === 'transferred') {
    await audit(actor, 'contact_transferred', contact._id, company.name, '', 'transfer:' + contact._id);
    if (!contact.destinationName) await Company.updateOne({ _id: company._id }, { $set: { decision: 'existing', crmLeadId: result.leadId } });
    await Contact.updateOne({ _id: contact._id }, { $set: { status: 'transferred', crmLeadId: result.leadId, crmContactId: result.contactId, transferredAt: new Date(), note: '' } });
  } else await Contact.updateOne({ _id: contact._id }, { $set: { status: 'duplicate', note: result.message } });
  return result;
};
router.post('/transfer', async (req, res) => {
  if (!Array.isArray(req.body.contactIds) || !req.body.contactIds.length || req.body.contactIds.length > 100) throw fail(400, 'Select between 1 and 100 contacts.');
  const results = [];
  for (const contactId of [...new Set(req.body.contactIds)]) {
    try { results.push(await transfer(contactId, req.user)); }
    catch (e) { results.push({ id: contactId, status: 'error', message: /Transaction numbers|replica set|mongos/i.test(e.message) ? 'Transfers require MongoDB Atlas or a replica set. No contact was moved.' : e.message }); }
  }
  res.json({ results });
});
router.use((err, req, res, next) => {
  console.error('[ContactReview]', err.message);
  res.status(err.status || (err instanceof multer.MulterError ? 400 : 500)).json({ message: err.status || err instanceof multer.MulterError ? err.message : 'Contact review could not complete this operation. Check server configuration and try again.' });
});
module.exports = router;
