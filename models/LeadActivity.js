const mongoose = require('mongoose');
const { connection } = require('../services/crmConnection');
module.exports = connection.model('ReviewCrmActivity', new mongoose.Schema({ leadId: mongoose.Schema.Types.ObjectId, type: String, description: String, performedBy: mongoose.Schema.Types.ObjectId, performedByName: String, metadata: mongoose.Schema.Types.Mixed, timestamp: { type: Date, default: Date.now } }, { autoIndex: false }), 'leadactivities');
