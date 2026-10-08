require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const demo = process.argv.includes('--demo');
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.get('/api/config', (req, res) => res.json({ demo, crmConnected: !demo && Boolean(process.env.CRM_MONGO_URI), stagingConnected: !demo && mongoose.connection.readyState === 1 }));
const attempts = new Map();
app.post('/api/login', async (req, res) => {
  if (demo) return res.json({ token: 'demo', email: 'demo@example.com' });
  const key = req.ip + ':' + String(req.body.email || '').trim().toLowerCase().slice(0,100), now = Date.now();
  let state = attempts.get(key);
  if (!state || now - state.start > 15 * 60_000) { state = { start: now, count: 0 }; attempts.set(key, state); }
  if (++state.count > 10) return res.status(429).json({ message: 'Too many sign-in attempts. Try again in 15 minutes.' });
  const username = String(req.body.email || '').trim().toLowerCase();
  let user, payload;
  if (username === process.env.REVIEW_ADMIN_EMAIL.toLowerCase()) {
    if (await bcrypt.compare(String(req.body.password || ''), app.locals.passwordHash)) { user = { email: username, name: 'Administrator', role: 'admin' }; payload = { email: username }; }
  } else {
    const account = await require('./models/teamModels').User.findOne({ username, active: true }).select('+passwordHash');
    const hash = account?.passwordHash || app.locals.passwordHash;
    const valid = await bcrypt.compare(String(req.body.password || ''), hash);
    if (account && valid) { user = { id: account._id, email: account.username, name: account.name, role: 'member' }; payload = { sub: String(account._id), version: account.version }; }
  }
  if (!user) return res.status(401).json({ message: 'Username or password is incorrect.' });
  attempts.delete(key);
  res.json({ token: jwt.sign(payload, process.env.REVIEW_JWT_SECRET, { expiresIn: '8h', audience: 'contact-review' }), user });
});
setInterval(() => { const now = Date.now(); for (const [key, state] of attempts) if (now - state.start > 15 * 60_000) attempts.delete(key); }, 15 * 60_000).unref();
if (!demo) app.use('/api/team', require('./routes/teamRoutes'));
app.use('/api/contact-review', demo ? require('./routes/demoRoutes') : require('./routes/contactReviewRoutes'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ message: 'Endpoint not found.' }));
app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.status ? error.message : 'Unable to complete the request.' }));
async function start() {
  if (!demo) {
    for (const key of ['CONTACT_REVIEW_MONGO_URI', 'REVIEW_ADMIN_EMAIL', 'REVIEW_ADMIN_PASSWORD', 'REVIEW_JWT_SECRET']) if (!process.env[key]) throw new Error(`Set ${key} in .env. Use npm run demo for a preview without databases.`);
    if (process.env.REVIEW_JWT_SECRET.length < 32) throw new Error('REVIEW_JWT_SECRET must have at least 32 characters.');
    if (process.env.REVIEW_ADMIN_PASSWORD.length < 12) throw new Error('REVIEW_ADMIN_PASSWORD must have at least 12 characters.');
    if (process.env.CRM_MONGO_URI && process.env.CRM_MONGO_URI === process.env.CONTACT_REVIEW_MONGO_URI) throw new Error('Staging and CRM must use different database URLs.');
    app.locals.passwordHash = await bcrypt.hash(process.env.REVIEW_ADMIN_PASSWORD, 12);
    await mongoose.connect(process.env.CONTACT_REVIEW_MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await require('./models/contactReviewModels')();
    const team = require('./models/teamModels'); await Promise.all([team.User.init(), team.Activity.init()]);
  }
  const port = Number(process.env.PORT) || 5100;
  const host = demo ? '127.0.0.1' : process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`Contact Review ${demo ? '(DEMO — sample data, no CRM writes)' : ''}: http://${host}:${port}`));
}
if (require.main === module) start().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { app, start };
