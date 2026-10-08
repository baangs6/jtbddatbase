const mongoose = require('mongoose');
const { connection } = require('../services/crmConnection');
// Match the existing CRM collections without changing its schema or indexes.
const poc = new mongoose.Schema({ name: String, designation: String, email: String, phone: String, alternate_phone: String, additionalPhones: [String], linkedin_url: String, stage: String, approvalStatus: String, createdBy: mongoose.Schema.Types.ObjectId, createdAt: { type: Date, default: Date.now } }, { strict: false });
const schema = new mongoose.Schema({ company_name: String, website_url: String, status: String, stage: { type: String, default: 'New' }, points_of_contact: [poc], assignedBy: mongoose.Schema.Types.ObjectId, createdBy: mongoose.Schema.Types.ObjectId, assignedTo: [mongoose.Schema.Types.ObjectId], lead_source: String }, { strict: false, timestamps: true, autoIndex: false });
module.exports = connection.model('ReviewCrmLead', schema, 'leads');
