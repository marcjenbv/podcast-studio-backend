const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const supabase = require('../supabase');

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// ── Register ─────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = await bcrypt.hash(password, 12);
  const { data, error } = await supabase
    .from('users')
    .insert({ email: email.toLowerCase().trim(), password_hash: hash, subscription_status: 'inactive' })
    .select('id, email')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    return res.status(500).json({ error: 'Registration failed' });
  }
  res.json({ token: signToken(data.id), user: { id: data.id, email: data.email, subscription_status: 'inactive' } });
});

// ── Login ────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data: user } = await supabase
    .from('users')
    .select('id, email, password_hash, subscription_status, subscription_end')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const { password_hash, ...safe } = user;
  res.json({ token: signToken(user.id), user: safe });
});

// ── Me ───────────────────────────────────────────────
router.get('/me', require('../middleware/auth'), async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
