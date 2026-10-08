const crypto = require('crypto');
const clean = value => String(value || '').normalize('NFKC').trim();
const companyKey = value => clean(value).toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const matchName = value => companyKey(value).replace(/\b(private|pvt|limited|ltd|incorporated|inc|llc|plc|corporation|corp)\b/g, '').replace(/\s+/g, ' ').trim();
const emailKey = value => clean(value).toLowerCase();
const phoneKey = value => {
  let digits = clean(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
};
const website = value => {
  if (!clean(value)) return '';
  const url = new URL(/^https?:\/\//i.test(clean(value)) ? clean(value) : `https://${clean(value)}`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.') || /^(localhost|127\.|0\.)/i.test(url.hostname)) throw new Error('Enter a valid public company website.');
  return `https://${url.hostname.toLowerCase().replace(/^www\./, '')}`;
};
const similarity = (a, b) => {
  a = matchName(a); b = matchName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = new Set(a.split(' ')), right = new Set(b.split(' '));
  const common = [...left].filter(x => right.has(x)).length;
  const tokenScore = 2 * common / (left.size + right.size);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
    prev = next;
  }
  return Math.max(tokenScore, 1 - prev[b.length] / Math.max(a.length, b.length));
};
const duplicateReason = (a, b) => {
  if (emailKey(a.email) && emailKey(a.email) === emailKey(b.email)) return 'Same email';
  const leftPhones = contactPhones(a).map(phoneKey);
  if (contactPhones(b).map(phoneKey).some(key => key && leftPhones.includes(key))) return 'Same phone — verify shared numbers';
  return '';
};
const contactPhones = row => [row.phone, row.alternate_phone, ...(row.additionalPhones || [])].filter(value => phoneKey(value));
const uniquePhones = rows => {
  const phones = new Map();
  for (const row of rows) for (const phone of contactPhones(row)) if (!phones.has(phoneKey(phone))) phones.set(phoneKey(phone), clean(phone));
  return [...phones.values()];
};
const profileKey = value => clean(value).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\?.*$/, '').replace(/\/$/, '');
const samePerson = (a, b) => {
  if (a.companyKey !== b.companyKey) return false;
  const nameA = companyKey(a.name), nameB = companyKey(b.name);
  if (nameA && nameB && nameA !== nameB) return false;
  const profileA = profileKey(a.linkedin_url), profileB = profileKey(b.linkedin_url);
  if (profileA && profileB && profileA !== profileB) return false;
  if (profileA && profileA === profileB) return true;
  if (!nameA || nameA !== nameB) return false;
  if (emailKey(a.email) && emailKey(b.email) && emailKey(a.email) !== emailKey(b.email)) return false;
  if (emailKey(a.email) && emailKey(a.email) === emailKey(b.email)) return true;
  const roleA = companyKey(a.designation), roleB = companyKey(b.designation);
  if (!roleA || roleA !== roleB) return false;
  return true;
};
const fingerprint = row => crypto.createHash('sha256').update(JSON.stringify([companyKey(row.company_name), companyKey(row.name), emailKey(row.email), phoneKey(row.phone), companyKey(row.designation)])).digest('hex');
const candidates = (name, leads) => leads.map(lead => ({ ...lead, score: similarity(name, lead.company_name) })).filter(x => x.score >= 0.55).sort((a, b) => b.score - a.score).slice(0, 10);
module.exports = { clean, companyKey, matchName, emailKey, phoneKey, website, similarity, duplicateReason, fingerprint, candidates, contactPhones, uniquePhones, samePerson, profileKey };
