const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User, Activity } = require('../models/teamModels');
const router = express.Router();
router.use(require('../middleware/authMiddleware'));
router.get('/me', (req, res) => res.json(req.user));
router.get('/my-today', async (req, res) => {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const start = new Date(date + 'T00:00:00+05:30');
  const rows = await Activity.aggregate([
    { $match: { actorId: String(req.user.id || 'administrator'), at: { $gte: start, $lt: new Date(start.getTime() + 86400000) } } },
    { $group: { _id: '$action', count: { $sum: 1 } } }
  ]);
  res.json({ date, timezone: 'Asia/Kolkata', counts: Object.fromEntries(rows.map(row => [row._id, row.count])) });
});
router.use((req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Administrator access required.' }));
router.get('/users', async (req, res) => res.json(await User.find().sort({ name: 1 }).lean()));
router.post('/users', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0,100), username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !/^[a-z0-9._@+-]{3,100}$/.test(username) || username === process.env.REVIEW_ADMIN_EMAIL.toLowerCase() || password.length < 12 || password.length > 128) return res.status(400).json({ message: 'Enter a name, unique username (3–100 characters), and password (12–128 characters).' });
  try { const user = await User.create({ name, username, passwordHash: await bcrypt.hash(password,12) }); res.status(201).json({ id: user._id, name, username, active: true }); }
  catch(e) { if (e.code === 11000) return res.status(409).json({ message: 'Username already exists.' }); throw e; }
});
router.patch('/users/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid account.' });
  const update = {};
  if (typeof req.body.active === 'boolean') update.active = req.body.active;
  if (req.body.password !== undefined) { const password = String(req.body.password); if (password.length < 12 || password.length > 128) return res.status(400).json({ message: 'Password must contain 12–128 characters.' }); update.passwordHash = await bcrypt.hash(password,12); }
  if (!Object.keys(update).length) return res.status(400).json({ message: 'Choose account status or a new password.' });
  const user = await User.findByIdAndUpdate(req.params.id, { $set: update, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
  if (!user) return res.status(404).json({ message: 'Account not found.' });
  res.json(user);
});
router.get('/report', async (req, res) => {
  const date = String(req.query.date || new Intl.DateTimeFormat('en-CA',{ timeZone: 'Asia/Kolkata' }).format(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10) !== date) return res.status(400).json({ message: 'Choose a valid date.' });
  const start = new Date(date+'T00:00:00+05:30'), end = new Date(start.getTime()+86400000);
  const filter = { at: { $gte: start, $lt: end } };
  if (req.query.user) filter.actorId = String(req.query.user);
  const [summary, events, total] = await Promise.all([
    Activity.aggregate([{ $match: filter }, { $group: { _id: { actorId: '$actorId', action: '$action' }, name: { $last: '$actorName' }, username: { $last: '$username' }, count: { $sum: 1 }, companies: { $addToSet: '$companyName' } } }]),
    Activity.find(filter).sort({ at:-1 }).limit(500).lean(), Activity.countDocuments(filter)
  ]);
  res.json({ date, timezone:'Asia/Kolkata', summary, events, total });
});
module.exports = router;
