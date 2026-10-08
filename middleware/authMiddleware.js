const jwt = require('jsonwebtoken');
module.exports = (req, res, next) => {
  try {
    const token = req.header('x-auth-token');
    const payload = jwt.verify(token || '', process.env.REVIEW_JWT_SECRET);
    if (payload.email !== process.env.REVIEW_ADMIN_EMAIL.toLowerCase() || payload.aud !== 'contact-review') throw new Error('Invalid session');
    req.user = { email: payload.email, name: 'Contact Review Admin' }; next();
  } catch { res.status(401).json({ message: 'Please sign in to the contact review app.' }); }
};
