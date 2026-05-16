const jwt      = require('jsonwebtoken');
const supabase = require('../supabase');

module.exports = async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, subscription_status, subscription_plan, subscription_end, minutes_used, minutes_topup, free_minutes_used, period_start')
      .eq('id', payload.sub)
      .single();
    if (error || !user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
