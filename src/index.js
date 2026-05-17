require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes    = require('./routes/auth');
const podcastRoutes = require('./routes/podcast');
const stripeRoutes  = require('./routes/stripe');
const userRoutes    = require('./routes/user');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Stripe webhook needs raw body — must be before express.json ──
app.post('/stripe/webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/stripe').webhook
);

// ── Trust Railway's proxy ────────────────────────────
app.set('trust proxy', 1);

// ── CORS — allow all origins ─────────────────────────
const corsOptions = {
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── Body parser ──────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting ────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60_000, max: 60,
  message: { error: 'Too many requests, please slow down.' },
});
const podcastLimiter = rateLimit({
  windowMs: 60_000, max: 10,
  message: { error: 'Podcast generation limit reached, please wait.' },
});
app.use('/auth',    limiter);
app.use('/podcast', podcastLimiter);
app.use('/user',    limiter);

// ── Routes ───────────────────────────────────────────
app.use('/auth',    authRoutes);
app.use('/podcast', podcastRoutes);
app.use('/stripe',  stripeRoutes);
app.use('/user',    userRoutes);

// ── Health check ─────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Global error handler ─────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`AI Podcast Studio backend running on port ${PORT}`);
});

