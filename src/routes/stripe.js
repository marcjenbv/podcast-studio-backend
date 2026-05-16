const router      = require('express').Router();
const stripe      = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase    = require('../supabase');
const requireAuth = require('../middleware/auth');
const { PLANS, TOPUPS } = require('../plans');

async function getOrCreateCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
  await supabase.from('users').update({ stripe_customer_id: customer.id }).eq('id', user.id);
  return customer.id;
}

// ── Create subscription checkout ──────────────────────
router.post('/create-checkout', requireAuth, async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  const priceId = process.env[plan.stripePriceEnv];
  if (!priceId) return res.status(500).json({ error: `Price not configured for ${planId}` });
  try {
    const customerId = await getOrCreateCustomer(req.user);
    const session = await stripe.checkout.sessions.create({
      customer:                  customerId,
      mode:                      'subscription',
      payment_method_types:      undefined,
      automatic_payment_methods: { enabled: true },
      line_items:                [{ price: priceId, quantity: 1 }],
      success_url:               `${process.env.FRONTEND_URL || 'http://localhost:5173'}/account?success=1`,
      cancel_url:                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/paywall`,
      subscription_data:         { trial_period_days: plan.billing === 'monthly' ? 7 : 0, metadata: { planId } },
      metadata:                  { planId },
      billing_address_collection: 'auto',
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Create top-up checkout ────────────────────────────
router.post('/create-topup', requireAuth, async (req, res) => {
  const { topupId } = req.body;
  const topup = TOPUPS.find(t => t.id === topupId);
  if (!topup) return res.status(400).json({ error: 'Invalid top-up' });
  const priceId = process.env[topup.stripePriceEnv];
  if (!priceId) return res.status(500).json({ error: `Price not configured for ${topupId}` });
  try {
    const customerId = await getOrCreateCustomer(req.user);
    const session = await stripe.checkout.sessions.create({
      customer:                  customerId,
      mode:                      'payment',
      payment_method_types:      undefined,
      automatic_payment_methods: { enabled: true },
      line_items:                [{ price: priceId, quantity: 1 }],
      success_url:               `${process.env.FRONTEND_URL || 'http://localhost:5173'}/account?topup=1`,
      cancel_url:                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/account`,
      metadata:                  { topupId, userId: req.user.id, minutesAdded: topup.minutes },
      billing_address_collection: 'auto',
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Customer portal ───────────────────────────────────
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('stripe_customer_id').eq('id', req.user.id).single();
    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'No subscription found' });
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/account`,
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stripe webhook ────────────────────────────────────
async function webhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    return res.status(400).json({ error: `Webhook error: ${e.message}` });
  }

  const obj = event.data.object;

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const status = (obj.status === 'active' || obj.status === 'trialing') ? 'active' : 'inactive';
    const end    = new Date(obj.current_period_end * 1000).toISOString();
    const planId = obj.metadata?.planId || 'starter_monthly';
    await supabase.from('users').update({
      subscription_status:    status,
      subscription_plan:      planId,
      subscription_end:       end,
      stripe_subscription_id: obj.id,
      ...(event.type === 'customer.subscription.created' ? { minutes_used: 0, period_start: new Date().toISOString() } : {}),
    }).eq('stripe_customer_id', obj.customer);
  }

  if (event.type === 'customer.subscription.deleted') {
    await supabase.from('users').update({
      subscription_status: 'inactive',
      subscription_plan:   'none',
      subscription_end:    null,
    }).eq('stripe_customer_id', obj.customer);
  }

  if (event.type === 'checkout.session.completed' && obj.mode === 'payment') {
    const { topupId, userId, minutesAdded } = obj.metadata || {};
    if (topupId && userId && minutesAdded) {
      const mins = parseInt(minutesAdded, 10);
      const { data: user } = await supabase.from('users').select('minutes_topup').eq('id', userId).single();
      await supabase.from('users').update({ minutes_topup: (user?.minutes_topup || 0) + mins }).eq('id', userId);
      await supabase.from('topup_purchases').insert({
        user_id: userId, minutes_added: mins,
        amount_cents: obj.amount_total, stripe_payment_intent_id: obj.payment_intent,
      });
    }
  }

  if (event.type === 'invoice.paid') {
    await supabase.from('users').update({ minutes_used: 0, period_start: new Date().toISOString() })
      .eq('stripe_customer_id', obj.customer);
  }

  res.json({ received: true });
}

router.webhook = webhook;
module.exports = router;
