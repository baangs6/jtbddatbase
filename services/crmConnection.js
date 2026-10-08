const mongoose = require('mongoose');
const connection = mongoose.createConnection();
let opening;
const isConfigured = () => Boolean(process.env.CRM_MONGO_URI);
const ensureConnected = async () => {
  if (!isConfigured()) throw Object.assign(new Error('CRM is not connected. Add CRM_MONGO_URI to the local .env file and restart.'), { status: 503 });
  if (connection.readyState !== 1) {
    if (!opening) opening = connection.openUri(process.env.CRM_MONGO_URI, { serverSelectionTimeoutMS: 8000, autoIndex: false }).catch(e => { opening = null; throw e; });
    await opening;
  }
  if (connection.name === mongoose.connection.name) throw Object.assign(new Error('CRM and staging must have different database names. Check the database names in both MongoDB URLs.'), { status: 503 });
  return connection;
};
module.exports = { connection, ensureConnected, isConfigured };
