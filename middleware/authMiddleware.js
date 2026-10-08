const jwt = require('jsonwebtoken');
module.exports = async (req, res, next) => {
  try {
    const payload = jwt.verify(req.header('x-auth-token') || '', process.env.REVIEW_JWT_SECRET, { audience: 'contact-review' });
    if (payload.sub) {
      const user = await require('../models/teamModels').User.findById(payload.sub).lean();
      if (!user || !user.active || user.version !== payload.version) throw new Error('Invalid session');
      req.user = { id: user._id, email: user.username, name: user.name, role: 'member' };
    } else {
      if (payload.email !== process.env.REVIEW_ADMIN_EMAIL.toLowerCase()) throw new Error('Invalid session');
      req.user = { email: payload.email, name: 'Administrator', role: 'admin' };
    }
    next();
  } catch { res.status(401).json({ message: 'Please sign in to the contact review app.' }); }
};
