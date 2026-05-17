const router      = require('express').Router();
const fetch       = require('node-fetch');
const requireAuth = require('../middleware/auth');
const supabase    = require('../supabase');
const { canGeneratePodcast, freeMinutesRemaining, PLANS, FREE_MINUTES } = require('../plans');

const ANTHROPIC_URL  = 'https://api.anthropic.com/v1/messages';
const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

const DURATION_CFG = {
  5:  { exchanges: 30,  maxTokens: 4000  },
  15: { exchanges: 80,  maxTokens: 8000  },
  30: { exchanges: 160, maxTokens: 16000 },
  45: { exchanges: 240, maxTokens: 24000 },
  60: { exchanges: 320, maxTokens: 32000 },
};

const LANG_NAMES = {
  en:'English', nl:'Dutch',   de:'German',     fr:'French',
  es:'Spanish', it:'Italian', pt:'Portuguese', pl:'Polish',
  ja:'Japanese',zh:'Chinese', ar:'Arabic',     hi:'Hindi',
  ko:'Korean',  sv:'Swedish', da:'Danish',     fi:'Finnish',
  tr:'Turkish', ru:'Russian',
};

async function callAnthropic(system, messages, maxTokens) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 8000,
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `Anthropic HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// ── Enhance text with natural speech markers before TTS ──
function enhanceForSpeech(text) {
  let t = text.trim();

  // Add breath pauses at natural points
  t = t.replace(/, /g, ',  ');                          // comma = short pause
  t = t.replace(/\. /g, '.  ');                         // period = longer pause
  t = t.replace(/— /g, '—  ');                          // dash = dramatic pause
  t = t.replace(/\.\.\./g, '...');                      // ellipsis = trailing off

  // Interruption starters — make them punchy with a beat before continuing
  t = t.replace(/^(Wait[,—]?)\s*/i,   '$1  ');
  t = t.replace(/^(No[,—]?)\s*/i,     '$1  ');
  t = t.replace(/^(But[,—]?)\s*/i,    '$1  ');
  t = t.replace(/^(Okay[,—]?)\s*/i,   '$1  ');
  t = t.replace(/^(Look[,—]?)\s*/i,   '$1  ');
  t = t.replace(/^(Right[,—]?)\s*/i,  '$1  ');
  t = t.replace(/^(Come on[,—]?)\s*/i,'$1  ');
  t = t.replace(/^(Exactly[,—]?)\s*/i,'$1  ');

  // Emphasis on key words — wrap numbers and strong claims
  t = t.replace(/(\d+%)/g, '$1');                       // percentages stay as-is (EL emphasises naturally)
  t = t.replace(/(never|always|everyone|nobody|impossible|wrong|completely|absolutely)/gi, '$1');

  return t;
}

async function synthesizeVoice(text, voiceId) {
  const enhanced    = enhanceForSpeech(text);
  const isQuestion  = text.trim().endsWith('?');
  const isExclaim   = text.includes('!');
  const isInterrupt = /^(Wait|No,|But |Actually|Hold on|Exactly|Right,|Come on|Look,|Okay)/i.test(text);
  const isShort     = text.split(' ').length < 8;

  // Lower stability = more natural variation in pitch and pace
  // Higher style = more expressive, emotional delivery
  const stability        = isInterrupt ? 0.12 : isQuestion ? 0.18 : isShort ? 0.15 : 0.22;
  const style            = isExclaim   ? 0.85 : isQuestion ? 0.72 : isInterrupt ? 0.78 : 0.65;
  const similarity_boost = 0.65;  // Lower = more natural, less clone-like

  const res = await fetch(`${ELEVENLABS_URL}/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      text:     enhanced,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability, similarity_boost, style, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail?.message || `ElevenLabs HTTP ${res.status}`);
  }
  const buffer = await res.buffer();
  return buffer.toString('base64');
}

function buildScriptPrompt(topic, context, langCode, tone, participants, duration) {
  const langName  = LANG_NAMES[langCode] || 'English';
  const cfg       = DURATION_CFG[duration] || DURATION_CFG[15];
  const guestList = participants.map(p =>
    `- ${p.name} (${p.role})${p.focus ? ' — angle: ' + p.focus : ''}`
  ).join('\n');

  return `Write a COMPLETE ${duration}-minute ${tone.toLowerCase()} podcast script in ${langName}.

Topic: "${topic}"
${context ? `Context the guests know:\n${context}\n` : ''}
Guests:
${guestList}

Target: ${cfg.exchanges} exchanges total. Write ALL of them now — do not stop early.

HOW REAL PODCASTS ACTUALLY SOUND — follow these patterns exactly:

TURN LENGTH: Most turns are 1-2 sentences. Occasionally 3. Rarely more.
Bad: "That's a fascinating point Sara. I think the key issue here is that when we look at the data from multiple sources including the McKinsey report from 2023, we can see that..."
Good: "The McKinsey data is clear. 40% of jobs disrupted by 2035."

INTERRUPTIONS — cut each other off constantly:
"But the thing is—" / "The thing is it's already happening."
"So you're saying—" / "I'm saying we're too late."
"Hang on—" / "No, let me finish."

REACTIONS — not formal transitions:
"Wait, really?" / "Exactly." / "Come on." / "Okay but—" / "That's the point!" / "Prove it." / "When?" / "Which ones?" / "Seriously?"

RHYTHM EXAMPLE — notice the pace:
Alex: "The EU AI Act changes everything."
Sara: "For who?"
Alex: "For companies over 50 employees."
Sara: "That's basically everyone."
James: "Not startups."
Sara: "Startups scale. Then what?"
Alex: "Then they comply or pay."
James: "Or leave Europe."
Sara: "Some will."
Alex: "Most won't. The market's too big."
James: "You sound very confident about that."
Alex: "I am."
Sara: "I'm not."

CONVERSATION ARC across ${cfg.exchanges} exchanges:
- Exchanges 1-${Math.round(cfg.exchanges*0.15)}: Fast intros, each guest stakes their position in 2-3 turns
- Exchanges ${Math.round(cfg.exchanges*0.15)}-${Math.round(cfg.exchanges*0.7)}: The real fight — specific claims, direct challenges, real examples, data, stories
- Exchanges ${Math.round(cfg.exchanges*0.7)}-${Math.round(cfg.exchanges*0.85)}: An unexpected moment — agreement on something surprising, or a question nobody can answer
- Exchanges ${Math.round(cfg.exchanges*0.85)}-${cfg.exchanges}: Landing — what do they each actually believe? Leave some things unresolved.

ABSOLUTE RULES:
- ALL text in ${langName}
- NEVER "Great point!", "Absolutely!", "That's fascinating!", "Indeed"
- NEVER reference being on a podcast or being an AI
- Guests use each other's names sometimes, not always
- Be specific: cite real examples, real numbers, real places, real names
- Each guest has a consistent personality throughout

Return ONLY valid JSON array, zero markdown, zero explanation:
[{"speaker":"Name","text":"words"},...]`;
}

// ── Generate podcast ───────────────────────────────────
router.post('/generate', requireAuth, async (req, res) => {
  const { topic, context, language, tone, duration, participants } = req.body;

  if (!topic || !participants || participants.length < 2) {
    return res.status(400).json({ error: 'topic and at least 2 participants required' });
  }

  const check = canGeneratePodcast(req.user, duration);
  if (!check.allowed) {
    if (check.reason === 'free_tier_exhausted')  return res.status(403).json({ error: 'free_tier_exhausted' });
    if (check.reason === 'insufficient_minutes') return res.status(403).json({ error: 'insufficient_minutes', remaining: check.remaining });
    return res.status(403).json({ error: 'subscription_required' });
  }

  try {
    const cfg    = DURATION_CFG[duration] || DURATION_CFG[15];
    const prompt = buildScriptPrompt(topic, context, language, tone, participants, duration);

    const raw = await callAnthropic(
      'You are a professional podcast scriptwriter. You write complete, natural, human-sounding dialogue.',
      [{ role: 'user', content: prompt }],
      cfg.maxTokens
    );

    const clean = raw.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('[');
    const end   = clean.lastIndexOf(']');
    if (start === -1) throw new Error('No valid script returned — please try again');

    let allTurns = JSON.parse(clean.slice(start, end + 1));
    allTurns = allTurns
      .filter(t => t.speaker && t.text?.trim())
      .map(t => ({ speaker: t.speaker.trim(), text: t.text.trim() }));

    if (allTurns.length < 5) throw new Error('Script too short — please try again');

    // Build voiceMap: assign each unique speaker a distinct voice
    // Strategy: try name match first, then assign by order of first appearance
    // This guarantees no two speakers share a voice
    const uniqueSpeakers = [...new Set(allTurns.map(t => t.speaker))];
    const usedVoiceIds   = new Set();
    const voiceMap       = {};

    uniqueSpeakers.forEach((speaker, i) => {
      // 1. Exact name match
      let p = participants.find(x => x.name === speaker);
      // 2. Case-insensitive
      if (!p) p = participants.find(x => x.name.toLowerCase() === speaker.toLowerCase());
      // 3. First name match
      if (!p) {
        const fn = speaker.split(' ')[0].toLowerCase();
        p = participants.find(x => x.name.toLowerCase().startsWith(fn));
      }
      // 4. Pick next participant whose voice hasn't been used
      if (!p) p = participants.find(x => !usedVoiceIds.has(x.voiceId));
      // 5. Final fallback — cycle through participants
      if (!p) p = participants[i % participants.length];

      const voiceId = p?.voiceId || participants[0]?.voiceId;
      voiceMap[speaker] = voiceId;
      usedVoiceIds.add(voiceId);
    });

    // Deduct minutes
    const plan = PLANS[req.user.subscription_plan];
    if (!plan) {
      const freeLeft = freeMinutesRemaining(req.user);
      if (freeLeft >= duration) {
        await supabase.from('users').update({ free_minutes_used: (req.user.free_minutes_used||0) + duration }).eq('id', req.user.id);
      } else {
        const fromTopup = duration - freeLeft;
        await supabase.from('users').update({
          free_minutes_used: (req.user.free_minutes_used||0) + freeLeft,
          minutes_topup:     Math.max(0, (req.user.minutes_topup||0) - fromTopup),
        }).eq('id', req.user.id);
      }
    } else {
      const periodStart   = new Date(req.user.period_start);
      const now           = new Date();
      const monthsElapsed = (now.getFullYear()-periodStart.getFullYear())*12+(now.getMonth()-periodStart.getMonth());
      if (monthsElapsed > 0) {
        await supabase.from('users').update({ minutes_used: duration, period_start: now.toISOString() }).eq('id', req.user.id);
      } else {
        const planRemaining = Math.max(0, plan.minutesPerPeriod - (req.user.minutes_used||0));
        if (duration <= planRemaining) {
          await supabase.from('users').update({ minutes_used: (req.user.minutes_used||0)+duration }).eq('id', req.user.id);
        } else {
          const fromTopup = duration - planRemaining;
          await supabase.from('users').update({
            minutes_used:  plan.minutesPerPeriod,
            minutes_topup: Math.max(0, (req.user.minutes_topup||0) - fromTopup),
          }).eq('id', req.user.id);
        }
      }
    }

    // Save
    const { data: podcast } = await supabase.from('podcasts').insert({
      user_id: req.user.id, topic, language, tone, duration,
      participants: JSON.stringify(participants),
      turns:        JSON.stringify(allTurns),
    }).select('id').single();

    res.json({ podcastId: podcast?.id, turns: allTurns, voiceMap });

  } catch(e) {
    console.error('Generation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Synthesize one turn ────────────────────────────────
router.post('/synthesize', requireAuth, async (req, res) => {
  const { text, voiceId } = req.body;
  if (!text || !voiceId) return res.status(400).json({ error: 'text and voiceId required' });
  try {
    const audio = await synthesizeVoice(text, voiceId);
    res.json({ audio });
  } catch(e) {
    console.error('TTS error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── History ────────────────────────────────────────────
router.get('/history', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('podcasts')
    .select('id, topic, language, tone, duration, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: 'Failed to fetch history' });
  res.json({ podcasts: data });
});

// ── Single podcast ─────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('podcasts')
    .select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (error || !data) return res.status(404).json({ error: 'Podcast not found' });
  res.json({ podcast: data });
});

module.exports = router;
