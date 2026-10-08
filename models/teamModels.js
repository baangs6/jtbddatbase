const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({ name: { type: String, required: true }, username: { type: String, required: true, unique: true }, passwordHash: { type: String, required: true, select: false }, active: { type: Boolean, default: true }, version: { type: Number, default: 0 } }, { timestamps: true });
const activitySchema = new mongoose.Schema({ actorId: String, actorName: String, username: String, action: String, entityId: String, companyName: String, detail: String, eventKey: { type: String, unique: true, sparse: true }, at: { type: Date, default: Date.now, index: true } });
module.exports = { User: mongoose.model('ReviewTeamUser', userSchema), Activity: mongoose.model('ReviewTeamActivity', activitySchema) };
