const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

test('isolated databases: import 8,000 contacts, confirm matches, transfer, block duplicates, retry safely', { timeout: 240000 }, async () => {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60000 }] });
  let server, crm;
  try {
    process.env.CONTACT_REVIEW_MONGO_URI = repl.getUri('test_staging');
    process.env.CRM_MONGO_URI = repl.getUri('test_crm');
    process.env.REVIEW_ADMIN_EMAIL = 'admin@test.example';
    process.env.REVIEW_ADMIN_PASSWORD = 'test-password-only-123';
    process.env.REVIEW_JWT_SECRET = 'test-secret-never-used-outside-isolated-tests-123';
    await mongoose.connect(process.env.CONTACT_REVIEW_MONGO_URI);
    crm = await mongoose.createConnection(process.env.CRM_MONGO_URI).asPromise();
    const userId = new mongoose.Types.ObjectId(), leadId = new mongoose.Types.ObjectId();
    await crm.collection('users').insertOne({ _id: userId, email: process.env.REVIEW_ADMIN_EMAIL, name: 'Test Admin', role: 'Admin', status: 'Active' });
    await crm.collection('leads').insertOne({ _id: leadId, company_name: 'ABC Technologies Pvt Ltd', stage: 'Proposal Sent', status: 'approved', assignedBy: userId, points_of_contact: [{ _id: new mongoose.Types.ObjectId(), name: 'Existing Person', email: 'exists@abc.example', phone: '9876543210' }] });
    const { app } = require('../server');
    app.locals.passwordHash = await bcrypt.hash(process.env.REVIEW_ADMIN_PASSWORD, 4);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async (url, body, method = 'POST', token = '') => {
      const res = await fetch(origin + url, { method, headers: { 'x-auth-token': token, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body == null ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    };
    assert.equal((await call('/api/contact-review/companies', null, 'GET')).status, 401);
    const login = await call('/api/login', { email: process.env.REVIEW_ADMIN_EMAIL, password: process.env.REVIEW_ADMIN_PASSWORD }); assert.equal(login.status, 200);
    const token = login.data.token;
    const mapping = { company_name: 'Company', name: 'Name', email: 'Email', phone: 'Phone' };
    const lines = ['Company,Name,Email,Phone', 'ABC Technologies,Existing Person,exists@abc.example,+91 9876543210', 'ABC Technologies,New Person,new@abc.example,9000011111', 'Fresh Industries,One,one@fresh.example,9000022222', 'Fresh Industries,Two,two@fresh.example,9000033333'];
    for (let i = 4; i < 8000; i++) lines.push(`Company ${Math.floor(i / 40)},Person ${i},person${i}@bulk.example,8${String(i).padStart(9, '0')}`);
    const csv = lines.join('\n');
    const form = () => { const f = new FormData(); f.append('file', new Blob([csv], { type: 'text/csv' }), 'contacts.csv'); f.append('mapping', JSON.stringify(mapping)); return f; };
    const preview = await call('/api/contact-review/import/preview', form(), 'POST', token); assert.equal(preview.data.count, 8000);
    const imported = await call('/api/contact-review/import', form(), 'POST', token); assert.equal(imported.status, 200); assert.equal(imported.data.inserted, 8000);
    const repeat = await call('/api/contact-review/import', form(), 'POST', token); assert.equal(repeat.data.inserted, 0); assert.equal(repeat.data.alreadyImported, 8000);
    assert.equal(await crm.collection('leads').countDocuments(), 1, 'Import never creates CRM leads');
    const { Contact, Company } = await require('../models/contactReviewModels')();
    const abc = await Company.findOne({ name: 'ABC Technologies' });
    const details = await call(`/api/contact-review/companies/${abc._id}`, null, 'GET', token);
    assert.equal(details.data.candidates[0].score, 1);
    assert.equal(details.data.contacts.find(c => c.email === 'exists@abc.example').duplicates[0].source, 'CRM');
    const newContact = await Contact.findOne({ email: 'new@abc.example' });
    const pending = await call('/api/contact-review/transfer', { contactIds: [String(newContact._id)] }, 'POST', token); assert.equal(pending.data.results[0].status, 'error');
    const linked = await call(`/api/contact-review/companies/${abc._id}`, { decision: 'existing', crmLeadId: String(leadId), website: 'abc.example', updateCrmWebsite: false }, 'PUT', token); assert.equal(linked.status, 200);
    assert.equal((await crm.collection('leads').findOne({ _id: leadId })).website_url, undefined);
    const move = await call('/api/contact-review/transfer', { contactIds: [String(newContact._id)] }, 'POST', token); assert.equal(move.data.results[0].status, 'transferred', JSON.stringify(move.data));
    const retry = await call('/api/contact-review/transfer', { contactIds: [String(newContact._id)] }, 'POST', token); assert.equal(retry.data.results[0].alreadyTransferred, true);
    // Simulate losing the staging acknowledgement after the CRM commit.
    await Contact.updateOne({ _id: newContact._id }, { $set: { status: 'pending' } });
    const reconciled = await call('/api/contact-review/transfer', { contactIds: [String(newContact._id)] }, 'POST', token); assert.equal(reconciled.data.results[0].status, 'transferred');
    const existing = await Contact.findOne({ email: 'exists@abc.example' });
    const blocked = await call('/api/contact-review/transfer', { contactIds: [String(existing._id)] }, 'POST', token); assert.equal(blocked.data.results[0].status, 'duplicate');
    const updated = await crm.collection('leads').findOne({ _id: leadId }); assert.equal(updated.points_of_contact.length, 2); assert.equal(updated.stage, 'New');
    const fresh = await Company.findOne({ name: 'Fresh Industries' });
    await call(`/api/contact-review/companies/${fresh._id}`, { decision: 'new', website: 'fresh.example' }, 'PUT', token);
    const freshContacts = await Contact.find({ companyKey: fresh.key });
    const outcomes = await Promise.all(freshContacts.map(c => call('/api/contact-review/transfer', { contactIds: [String(c._id)] }, 'POST', token)));
    // Concurrent creation of one company can ask the second caller to refresh; retry follows saved mapping.
    for (let i = 0; i < outcomes.length; i++) if (outcomes[i].data.results[0].status !== 'transferred') {
      const retryFresh = await call('/api/contact-review/transfer', { contactIds: [String(freshContacts[i]._id)] }, 'POST', token); assert.equal(retryFresh.data.results[0].status, 'transferred');
    }
    const freshLeads = await crm.collection('leads').find({ company_name: 'Fresh Industries' }).toArray(); assert.equal(freshLeads.length, 1); assert.equal(freshLeads[0].points_of_contact.length, 2);
    assert.equal(await mongoose.connection.collection('leads').countDocuments(), 0, 'CRM leads never appear in staging');
    assert.equal(await crm.collection('reviewcontacts').countDocuments(), 0, 'Imported contacts never appear in CRM staging collections');
    assert.equal(await Contact.countDocuments(), 8000);
    const combinedFile = new FormData();
    combinedFile.append('file', new Blob(['Company,Name,Email,Phone,Role\nABC Technologies,Same Person,same@abc.example,9000044444,Recruiter\nABC Technologies,Same Person,same@abc.example,9000055555,Recruiter\n']), 'two-numbers.csv');
    combinedFile.append('mapping', JSON.stringify({ ...mapping, designation: 'Role' }));
    const combined = await call('/api/contact-review/import', combinedFile, 'POST', token);
    assert.equal(combined.data.merged, 1);
    const single = await Contact.findOne({ name: 'Same Person', mergedInto: null });
    assert.equal(single.alternate_phone, '9000055555');
    assert.equal(await Contact.countDocuments({ name: 'Same Person', mergedInto: null }), 1);
    assert.equal(await Contact.countDocuments({ name: 'Same Person', status: 'merged' }), 1);
    const importedWithAlternative = await call('/api/contact-review/transfer', { contactIds: [String(single._id)] }, 'POST', token);
    assert.equal(importedWithAlternative.data.results[0].status, 'transferred');
    const leadWithAlternative = await crm.collection('leads').findOne({ _id: leadId });
    assert.equal(leadWithAlternative.points_of_contact.find(p => String(p._id) === String(single._id)).alternate_phone, '9000055555');
    const owner = new mongoose.Types.ObjectId(), inactive = new mongoose.Types.ObjectId();
    await crm.collection('users').insertMany([{ _id: owner, name: 'Active Recruiter', email: 'owner@test.example', role: 'User', status: 'Active' }, { _id: inactive, name: 'Inactive', status: 'Inactive' }]);
    const users = await call('/api/contact-review/crm-users', null, 'GET', token);
    assert.ok(users.data.some(u => u._id === String(owner)));
    assert.ok(!users.data.some(u => u._id === String(inactive)));
    const separate = await Contact.find({ status: 'pending', companyKey: { $ne: abc.key } }).limit(2);
    for (let i = 0; i < separate.length; i++) {
      const path = '/api/contact-review/contacts/' + separate[i]._id;
      const invalid = await call(path, { destinationName: 'Custom ' + i, destinationWebsite: 'custom' + i + '.example', ownerId: String(inactive) }, 'PATCH', token);
      assert.equal(invalid.status, 400);
      const saved = await call(path, { destinationName: 'Custom ' + i, destinationWebsite: 'custom' + i + '.example', ownerId: String(owner) }, 'PATCH', token);
      assert.equal(saved.status, 200);
      const moved = await call('/api/contact-review/transfer', { contactIds: [String(separate[i]._id)] }, 'POST', token);
      assert.equal(moved.data.results[0].status, 'transferred', JSON.stringify(moved.data));
      const created = await crm.collection('leads').findOne({ company_name: 'Custom ' + i });
      assert.equal(String(created.assignedTo[0]), String(owner));
      assert.equal(String(created.assignedBy), String(owner));
      assert.equal(String(created.createdBy), String(userId));
      assert.equal(created.points_of_contact.length, 1);
    }

    const { User, Activity } = require('../models/teamModels');
    await Promise.all([User.init(), Activity.init()]);
    const createdUser = await call('/api/team/users', { name: 'Entry One', username: 'entry.one', password: 'team-test-password-123' }, 'POST', token);
    assert.equal(createdUser.status, 201);
    assert.equal((await call('/api/team/users', { name: 'Duplicate', username: 'entry.one', password: 'team-test-password-123' }, 'POST', token)).status, 409);
    const memberLogin = await call('/api/login', { email: 'ENTRY.ONE', password: 'team-test-password-123' });
    assert.equal(memberLogin.status, 200);
    const memberToken = memberLogin.data.token;
    assert.equal((await call('/api/team/me', null, 'GET', memberToken)).data.name, 'Entry One');
    assert.equal((await call('/api/team/users', null, 'GET', memberToken)).status, 403);
    assert.equal((await call('/api/contact-review/import/preview', null, 'POST', memberToken)).status, 403);
    const accountList = await call('/api/team/users', null, 'GET', token);
    assert.ok(accountList.data.every(u => !u.passwordHash));
    const teamContact = await Contact.findOne({ status: 'pending', companyKey: { $ne: abc.key } });
    const teamCompany = await Company.findOne({ key: teamContact.companyKey });
    assert.equal((await call('/api/contact-review/companies/' + teamCompany._id + '/review-status', { reviewStatus: 'verify_later' }, 'PATCH', memberToken)).status, 200);
    assert.equal((await call('/api/contact-review/contacts/' + teamContact._id, { destinationName: 'Team Destination', destinationWebsite: 'team.example', ownerId: String(owner) }, 'PATCH', memberToken)).status, 200);
    const memberMove = await call('/api/contact-review/transfer', { contactIds: [String(teamContact._id)] }, 'POST', memberToken);
    assert.equal(memberMove.data.results[0].status, 'transferred', JSON.stringify(memberMove.data));
    await call('/api/contact-review/transfer', { contactIds: [String(teamContact._id)] }, 'POST', memberToken);
    const teamLead = await crm.collection('leads').findOne({ company_name: 'Team Destination' });
    assert.equal(String(teamLead.assignedBy), String(owner), 'CRM owner is separate from entry member');
    assert.equal(await Activity.countDocuments({ actorId: createdUser.data.id, action: 'contact_transferred' }), 1);
    await Activity.create({ actorId: createdUser.data.id, actorName: 'Entry One', username: 'entry.one', action: 'company_review', companyName: 'Boundary', at: new Date('2026-10-07T18:30:00Z') });
    await Activity.create({ actorId: createdUser.data.id, actorName: 'Entry One', username: 'entry.one', action: 'company_review', companyName: 'Before', at: new Date('2026-10-07T18:29:59Z') });
    const report = await call('/api/team/report?date=2026-10-08&user=' + createdUser.data.id, null, 'GET', token);
    assert.equal(report.status, 200);
    assert.ok(report.data.events.some(e => e.companyName === 'Boundary'));
    assert.ok(!report.data.events.some(e => e.companyName === 'Before'));
    assert.equal((await call('/api/team/report', null, 'GET', memberToken)).status, 403);
    assert.equal((await call('/api/team/report?date=2026-02-31', null, 'GET', token)).status, 400);
    const disabled = await call('/api/team/users/' + createdUser.data.id, { active: false }, 'PATCH', token);
    assert.equal(disabled.status, 200); assert.ok(!disabled.data.passwordHash);
    assert.equal((await call('/api/team/me', null, 'GET', memberToken)).status, 401);
    assert.equal((await call('/api/login', { email: 'entry.one', password: 'team-test-password-123' })).status, 401);
    await call('/api/team/users/' + createdUser.data.id, { active: true, password: 'changed-team-password-123' }, 'PATCH', token);
    assert.equal((await call('/api/login', { email: 'entry.one', password: 'team-test-password-123' })).status, 401);
    assert.equal((await call('/api/login', { email: 'entry.one', password: 'changed-team-password-123' })).status, 200);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await require('../services/crmConnection').connection.close();
    if (crm) await crm.close();
    await mongoose.disconnect(); await repl.stop();
  }
});

