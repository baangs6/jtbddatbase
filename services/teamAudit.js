const { Activity } = require('../models/teamModels');
module.exports = async (user, action, entityId, companyName, detail = '', eventKey) => {
  const record = { actorId: String(user.id || 'administrator'), actorName: user.name, username: user.email, action, entityId: String(entityId || ''), companyName, detail, at: new Date() };
  if (eventKey) await Activity.updateOne({ eventKey }, { $setOnInsert: { ...record, eventKey } }, { upsert: true });
  else await Activity.create(record);
};
