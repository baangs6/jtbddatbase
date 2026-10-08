const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../services/contactReviewMatching');
const readCsv = require('../services/csvImport');
test('legal suffix matches are suggestions, grouping retains distinct legal names', () => {
  assert.equal(m.similarity('ABC Technologies Pvt. Ltd.', 'ABC Technologies Private Limited'), 1);
  assert.notEqual(m.companyKey('ABC Technologies Pvt Ltd'), m.companyKey('ABC Technologies'));
  assert.equal(m.similarity('', ''), 0);
});
test('email and Indian phone formatting identify duplicates without empty matches', () => {
  assert.match(m.duplicateReason({ email: ' Person@Example.com ' }, { email: 'person@example.com' }), /email/);
  assert.match(m.duplicateReason({ phone: '+91 98765 43210' }, { phone: '09876543210' }), /phone/);
  assert.equal(m.duplicateReason({ name: 'Ravi' }, { name: 'Ravi' }), '');
  assert.equal(m.phoneKey('+44 1234567890'), '441234567890');
});
test('import fingerprints survive case and phone formatting but preserve company distinctions', () => {
  assert.equal(m.fingerprint({ company_name: 'ABC', name: 'RAVI', email: 'R@x.com', phone: '+91 98765 43210' }), m.fingerprint({ company_name: 'abc', name: 'Ravi', email: 'r@x.com', phone: '9876543210' }));
  assert.notEqual(m.fingerprint({ company_name: 'ABC', email: 'r@x.com' }), m.fingerprint({ company_name: 'XYZ', email: 'r@x.com' }));
});
test('website accepts public HTTP domains and rejects credentials and executable URLs', () => {
  assert.equal(m.website('https://www.Example.com/path'), 'https://example.com');
  assert.throws(() => m.website('https://user:pass@example.com'));
  assert.throws(() => m.website('javascript:alert(1)'));
  assert.throws(() => m.website('localhost'));
});
test('CSV handles BOM, quoted commas, and multiline cells', async () => {
  const data = await readCsv(Buffer.from('\uFEFFCompany,Name,Email\n"ABC, Inc","Ravi\nKumar",r@example.com\n'));
  assert.deepEqual(data.headers, ['Company', 'Name', 'Email']); assert.equal(data.rows[0].Company, 'ABC, Inc'); assert.equal(data.rows[0].Name, 'Ravi\nKumar');
});
test('CSV rejects duplicate headings and malformed row widths', async () => {
  await assert.rejects(readCsv(Buffer.from('Company,Company\nABC,DEF\n')), /duplicate/);
  await assert.rejects(readCsv(Buffer.from('Company,Name\nABC,Ravi,Extra\n')), /length/);
});
test('same person combines different numbers but does not merge conflicting identities', () => {
  const a = { companyKey: 'abc', name: 'Ravi Kumar', designation: 'HR Manager', phone: '9876543210', linkedin_url: 'https://www.linkedin.com/in/ravi/' };
  const b = { ...a, phone: '9123456780', linkedin_url: 'https://linkedin.com/in/ravi' };
  assert.equal(m.samePerson(a, b), true);
  assert.deepEqual(m.uniquePhones([a, b]), ['9876543210', '9123456780']);
  assert.equal(m.samePerson(a, { ...b, linkedin_url: 'https://linkedin.com/in/another-ravi' }), false);
  assert.equal(m.samePerson(a, { ...b, companyKey: 'xyz' }), false);
  assert.equal(m.samePerson({ ...a, linkedin_url: '', email: 'ravi@a.com' }, { ...b, linkedin_url: '', email: 'ravi@b.com' }), false);
  assert.equal(m.duplicateReason({ phone: '1111111111', alternate_phone: '+91 9876543210' }, a), 'Same phone — verify shared numbers');
});
