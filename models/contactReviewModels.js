const mongoose = require('mongoose');
let ready;
module.exports = async () => {
  if (!ready) ready = (async () => {
    const db = mongoose.connection;
    const contact = new mongoose.Schema({
      sourceKey: { type: String, unique: true, required: true }, companyKey: { type: String, index: true, required: true },
      company_name: String, name: String, email: String, phone: String, designation: String, linkedin_url: String,
      alternate_phone: String, additionalPhones: [String], phoneKeys: { type: [String], index: true },
      mergedInto: { type: mongoose.Schema.Types.ObjectId, index: true }, mergedAt: Date,
      emailKey: { type: String, index: true }, phoneKey: { type: String, index: true },
      status: { type: String, enum: ['pending', 'duplicate', 'transferred', 'skipped', 'merged'], default: 'pending' },
      crmLeadId: mongoose.Schema.Types.ObjectId, crmContactId: mongoose.Schema.Types.ObjectId, transferredAt: Date,
      destinationName: String, destinationWebsite: String, ownerId: mongoose.Schema.Types.ObjectId,
      importedBy: mongoose.Schema.Types.ObjectId, note: String
    }, { timestamps: true });
    const company = new mongoose.Schema({
      key: { type: String, unique: true, required: true }, name: String,
      reviewStatus: { type: String, enum: ['pending', 'no_hiring', 'verify_later', 'another_company'], default: 'pending' },
      decision: { type: String, enum: ['pending', 'existing', 'new'], default: 'pending' },
      crmLeadId: mongoose.Schema.Types.ObjectId, verifiedWebsite: String, reviewedBy: mongoose.Schema.Types.ObjectId
    }, { timestamps: true });
    const Contact = db.model('ReviewContact', contact), Company = db.model('ReviewCompany', company);
    await Promise.all([Contact.init(), Company.init()]);
    return { Contact, Company };
  })().catch(error => { ready = null; throw error; });
  return ready;
};
