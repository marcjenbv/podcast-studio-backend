const router      = require('express').Router();
const supabase    = require('../supabase');
const requireAuth = require('../middleware/auth');
const { minutesRemaining, freeMinutesRemaining, PLANS, TOPUPS, FREE_MINUTES } = require('../plans');

router.get('/status', requireAuth, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('subscription_status, subscription_plan, subscription_end, minutes_used, minutes_topup, free_minutes_used, period_start')
    .eq('id', req.user.id)
    .single();

  const plan         = PLANS[user?.subscription_plan] || null;
  const remaining    = minutesRemaining(user);
  const freeLeft     = freeMinutesRemaining(user);
  const isSubscribed = user?.subscription_status === 'active';

  res.json({
    subscription_status:    user?.subscription_status,
    subscription_plan:      user?.subscription_plan,
    subscription_end:       user?.subscription_end,
    plan_details:           plan,
    minutes_used:           user?.minutes_used || 0,
    minutes_topup:          user?.minutes_topup || 0,
    minutes_remaining:      remaining,
    period_start:           user?.period_start,
    is_free_tier:           !isSubscribed,
    free_minutes_total:     FREE_MINUTES,
    free_minutes_used:      user?.free_minutes_used || 0,
    free_minutes_remaining: freeLeft,
  });
});

module.exports = router;
