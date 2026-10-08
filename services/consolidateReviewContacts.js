const m = require('./contactReviewMatching');
module.exports = async Contact => {
  const rows = await Contact.find({ mergedInto: null, status: { $ne: 'transferred' } }).sort({ createdAt: 1, _id: 1 }).lean();
  const buckets = new Map();
  const survivorUpdates = new Map(), sources = [];
  let merged = 0;
  for (const row of rows) {
    const name = m.companyKey(row.name);
    const bucketKey = `${row.companyKey}\u0000${name || m.profileKey(row.linkedin_url) || row._id}`;
    const candidates = buckets.get(bucketKey) || [];
    // Compare against every original member to prevent bridging conflicting identities.
    const group = candidates.find(g => g.members.every(member => m.samePerson(member, row)));
    if (!group) { candidates.push({ survivor: row, members: [row] }); buckets.set(bucketKey, candidates); continue; }
    const target = group.survivor;
    const phones = m.uniquePhones([target, row]);
    const updates = { phone: phones[0] || '', alternate_phone: phones[1] || '', additionalPhones: phones.slice(2), phoneKeys: phones.map(m.phoneKey) };
    for (const field of ['name', 'email', 'designation', 'linkedin_url']) if (!target[field] && row[field]) updates[field] = row[field];
    if (updates.email) updates.emailKey = m.emailKey(updates.email);
    if (target.status === 'skipped' && row.status !== 'skipped') updates.status = row.status;
    const prior = survivorUpdates.get(String(target._id));
    survivorUpdates.set(String(target._id), { id: target._id, updates: { ...(prior?.updates || {}), ...updates } });
    sources.push({ id: row._id, target: target._id });
    Object.assign(target, updates); group.members.push(row); merged++;
  }
  // Copy all numbers before archiving sources; batch operations keep large imports responsive.
  const keepers = [...survivorUpdates.values()];
  for (let start = 0; start < keepers.length; start += 500) {
    const batch = keepers.slice(start, start + 500);
    const result = await Contact.bulkWrite(batch.map(row => ({ updateOne: { filter: { _id: row.id, mergedInto: null, status: { $ne: 'transferred' } }, update: { $set: row.updates } } })));
    if (result.matchedCount !== batch.length) throw new Error('Contacts changed during combining. Original records were kept; refresh and try again.');
  }
  for (let start = 0; start < sources.length; start += 500) await Contact.bulkWrite(sources.slice(start, start + 500).map(row => ({ updateOne: { filter: { _id: row.id, mergedInto: null, status: { $ne: 'transferred' } }, update: { $set: { status: 'merged', mergedInto: row.target, mergedAt: new Date() } } } })));
  // Backfill alternate-number indexes for every remaining visible record.
  const active = await Contact.find({ mergedInto: null }).select('phone alternate_phone additionalPhones').lean();
  for (let start = 0; start < active.length; start += 500) await Contact.bulkWrite(active.slice(start, start + 500).map(row => {
    const phones = m.uniquePhones([row]);
    return { updateOne: { filter: { _id: row._id, status: { $ne: 'transferred' } }, update: { $set: { phone: phones[0] || '', alternate_phone: phones[1] || '', additionalPhones: phones.slice(2), phoneKeys: phones.map(m.phoneKey) } } } };
  }));
  return { merged, visibleContacts: active.length };
};
