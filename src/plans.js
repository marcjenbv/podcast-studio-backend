// ── Free tier ─────────────────────────────────────────
const FREE_MINUTES = 15;

// ── Subscription plans ────────────────────────────────
const PLANS = {
  starter_monthly: { name:'Starter', billing:'monthly', price:'€6.99/mo',  minutesPerPeriod:60,  stripePriceEnv:'STRIPE_STARTER_MONTHLY_PRICE_ID' },
  creator_monthly: { name:'Creator', billing:'monthly', price:'€14.99/mo', minutesPerPeriod:180, stripePriceEnv:'STRIPE_CREATOR_MONTHLY_PRICE_ID' },
  pro_monthly:     { name:'Pro',     billing:'monthly', price:'€44.99/mo', minutesPerPeriod:600, stripePriceEnv:'STRIPE_PRO_MONTHLY_PRICE_ID'     },
  starter_annual:  { name:'Starter', billing:'annual',  price:'€67.99/yr',  minutesPerPeriod:60,  stripePriceEnv:'STRIPE_STARTER_ANNUAL_PRICE_ID'  },
  creator_annual:  { name:'Creator', billing:'annual',  price:'€143.99/yr', minutesPerPeriod:180, stripePriceEnv:'STRIPE_CREATOR_ANNUAL_PRICE_ID'  },
  pro_annual:      { name:'Pro',     billing:'annual',  price:'€431.99/yr', minutesPerPeriod:600, stripePriceEnv:'STRIPE_PRO_ANNUAL_PRICE_ID'      },
};

// ── Top-up packs ─────────────────────────────────────
const TOPUPS = [
  { id:'topup_60',  minutes:60,  price:'€4.99',  label:'60 min',   stripePriceEnv:'STRIPE_TOPUP_60_PRICE_ID'  },
  { id:'topup_180', minutes:180, price:'€12.99', label:'3 hours',  stripePriceEnv:'STRIPE_TOPUP_180_PRICE_ID' },
  { id:'topup_600', minutes:600, price:'€34.99', label:'10 hours', stripePriceEnv:'STRIPE_TOPUP_600_PRICE_ID' },
];

// ── Helpers ───────────────────────────────────────────
function getPlan(planName) {
  if (PLANS[planName]) return PLANS[planName];
  if (PLANS[planName + '_monthly']) return PLANS[planName + '_monthly'];
  return null;
}

function freeMinutesRemaining(user) {
  return Math.max(0, FREE_MINUTES - (user.free_minutes_used || 0));
}

function minutesRemaining(user) {
  const plan = getPlan(user.subscription_plan);
  if (!plan) {
    return freeMinutesRemaining(user) + (user.minutes_topup || 0);
  }
  const periodStart   = new Date(user.period_start);
  const now           = new Date();
  const monthsElapsed = (now.getFullYear() - periodStart.getFullYear()) * 12
    + (now.getMonth() - periodStart.getMonth());
  const used = monthsElapsed > 0 ? 0 : (user.minutes_used || 0);
  return Math.max(0, plan.minutesPerPeriod - used) + (user.minutes_topup || 0);
}

function canGeneratePodcast(user, requestedDuration) {
  const plan = getPlan(user.subscription_plan);
  if (!plan) {
    const freeLeft  = freeMinutesRemaining(user);
    const topupLeft = user.minutes_topup || 0;
    const total     = freeLeft + topupLeft;
    if (total < requestedDuration) {
      if ((user.free_minutes_used || 0) >= FREE_MINUTES && topupLeft === 0) {
        return { allowed: false, reason: 'free_tier_exhausted' };
      }
      return { allowed: false, reason: 'insufficient_minutes', remaining: total };
    }
    return { allowed: true, usesFreeMinutes: freeLeft > 0 };
  }
  const remaining = minutesRemaining(user);
  if (remaining < requestedDuration) {
    return { allowed: false, reason: 'insufficient_minutes', remaining };
  }
  return { allowed: true };
}

module.exports = { PLANS, TOPUPS, FREE_MINUTES, getPlan, minutesRemaining, freeMinutesRemaining, canGeneratePodcast };
