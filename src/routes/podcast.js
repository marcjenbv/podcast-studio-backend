const router      = require('express').Router();
const fetch       = require('node-fetch');
const requireAuth = require('../middleware/auth');
const supabase    = require('../supabase');
const { canGeneratePodcast, freeMinutesRemaining, PLANS, FREE_MINUTES } = require('../plans');

const ANTHROPIC_URL  = 'https://api.anthropic.com/v1/messages';
const ELEVENLABS_TTS_URL      = 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVENLABS_DIALOGUE_URL = 'https://api.elevenlabs.io/v1/text-to-dialogue';

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

// ── Text-to-Dialogue: synthesize a chunk of turns as one audio file ──
// This uses ElevenLabs v3 Dialogue API which generates natural multi-speaker
// audio in a single call — proper transitions, overlaps, natural flow.
// Max 2000 chars total text per request — we chunk accordingly.
async function synthesizeDialogueChunk(inputs, retries = 3) {
  // Add emotion tags to text based on content
  const enhancedInputs = inputs.map(inp => ({
    voice_id: inp.voice_id,
    text: addEmotionTags(inp.text),
  }));

  try {
    const res = await fetch(ELEVENLABS_DIALOGUE_URL, {
      method: 'POST',
      headers: {
        'xi-api-key':   process.env.ELEVENLABS_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        inputs:   enhancedInputs,
        model_id: 'eleven_v3',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '{}');
      console.error('ElevenLabs Dialogue API error:', res.status, body);
      let msg;
      try { msg = JSON.parse(body)?.detail?.message || JSON.parse(body)?.detail?.status || body; }
      catch { msg = body; }
      if (res.status === 429) throw new Error(`429 rate_limit: ${msg}`);
      if (res.status === 401) throw new Error(`ElevenLabs auth failed — check your API key`);
      if (res.status === 403) throw new Error(`ElevenLabs plan does not support Text-to-Dialogue (eleven_v3 requires paid plan)`);
      throw new Error(`ElevenLabs ${res.status}: ${msg}`);
    }
    const buffer = await res.buffer();
    return buffer.toString('base64');
  } catch(e) {
    if (retries > 0) {
      const is429 = e.message?.includes('429');
      const delay = is429 ? 8000 : 2000;
      await new Promise(r => setTimeout(r, delay));
      return synthesizeDialogueChunk(inputs, retries - 1);
    }
    throw e;
  }
}

// Add natural emotion tags based on text content
function addEmotionTags(text) {
  let t = text.trim();
  // Interruptions — cut-off marker
  if (t.endsWith('—') || t.endsWith('-')) {
    t = t; // already has interruption marker
  }
  // Laughter cues
  if (/(ha|haha|hah)/i.test(t)) t = '[laughs] ' + t;
  // Sighs
  if (/(I (don't|dont) know|whatever|anyway)/i.test(t) && t.split(' ').length < 8) {
    t = '[sighs] ' + t;
  }
  return t;
}

async function synthesizeVoice(text, voiceId, prevText = null, nextText = null, retries = 2) {
  // Per ElevenLabs docs (2025):
  // stability 0.40-0.50: emotional range without instability for conversation
  // similarity_boost 0.75: documented sweet spot for clarity
  // style 0: let the TEXT drive emotion via punctuation and word choice
  //          (style > 0 causes over-acting and sounds theatrical, not natural)
  // previous_text/next_text: CRITICAL for natural prosody — without this,
  //   each turn sounds read in isolation. These parameters let ElevenLabs
  //   know what came before/after so intonation flows naturally between speakers.
  const body = {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability:        0.45,
      similarity_boost: 0.75,
      style:            0,
      use_speaker_boost: true,
    },
  };
  if (prevText) body.previous_text = prevText;
  if (nextText) body.next_text     = nextText;

  try {
    const res = await fetch(`${ELEVENLABS_TTS_URL}/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      const msg = e.detail?.message || e.detail?.status || `ElevenLabs HTTP ${res.status}`;
      // Make 429 clearly identifiable so frontend can apply longer backoff
      if (res.status === 429) throw new Error(`429 rate_limit: ${msg}`);
      throw new Error(msg);
    }
    const buffer = await res.buffer();
    return buffer.toString('base64');
  } catch(e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000 * (3 - retries)));
      return synthesizeVoice(text, voiceId, prevText, nextText, retries - 1);
    }
    throw e;
  }
}

function buildScriptPrompt(topic, context, langCode, tone, participants, duration, hostConfig = null) {
  const langName  = LANG_NAMES[langCode] || 'English';
  const cfg       = DURATION_CFG[duration] || DURATION_CFG[15];
  const guestList = participants.map(p =>
    `- ${p.name} (${p.role})${p.focus ? ' — angle: ' + p.focus : ''}`
  ).join('\n');
  const hostLine = hostConfig && hostConfig.name
    ? `Host (guides discussion, asks questions, does NOT debate): ${hostConfig.name}\n`
    : '';

  return `Write a COMPLETE ${duration}-minute ${tone.toLowerCase()} podcast in ${langName}.

Topic: "${topic}"
${context ? `Background:\n${context}\n` : ''}
${hostLine}Guests:
${guestList}

TARGET: ${cfg.exchanges} exchanges. Write ALL of them.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOU ARE WRITING FOR ELEVENLABS eleven_v3
[audio tags] = PERFORMANCE DIRECTIONS, not spoken words
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT MAKES CONVERSATION SOUND HUMAN — apply all of these:

1. FILLERS & DISFLUENCIES (6% of real speech per linguistics research)
   "uh", "um", "I mean", "you know", "like", "well", "so", "right"
   "It's— it's weird." / "I uh— yeah, okay, fair."
   DO NOT write clean polished sentences. Real people don't speak in polished sentences.

2. INCOMPLETE THOUGHTS & RESTARTS
   "The thing is— no wait, that's not what I mean."
   "It's more like— okay, think of it this way."
   "I was going to say— actually, you know what, never mind."

3. REFERENCING WHAT WAS JUST SAID
   If Alex said "five companies control everything" →
   Sara says "[skeptical] 'Five companies.' Okay. Which five?"
   People repeat the other person's exact words back constantly.

4. BACKCHANNELS — short turns that show you're listening:
   "Right." / "Yeah." / "Okay." / "Huh." / "Really?" / "Come on."
   These are FULL TURNS, not additions to other turns.

5. TANGENTS & CIRCLES BACK
   Someone goes off on a related story, then someone pulls it back:
   "— wait, we're getting off topic."
   "— but that's kind of the point though, right?"

6. SELF-CORRECTION & HEDGING
   "Well— I don't know if that's exactly right, but—"
   "That's— that's probably too strong a way to put it."
   "Maybe I'm wrong about this but—"

AUDIO TAGS (use in EVERY turn, match to content):
[laughs] [chuckles] [sighs] [exhales] [hesitant] [frustrated] [excited]
[surprised] [interrupting] [skeptical] [thoughtful] [leaning in] [scoffs]
[nervous laugh] [emphatic] [quietly] [dryly] [trailing off] [under breath]

REAL CONVERSATION EXAMPLE — study every line:
{"speaker":"Tom","text":"[leaning in] Alright. So, uh— Marx versus Keynes in 2025. Alex, who wins?"}
{"speaker":"Alex","text":"[without hesitation] Marx. Not— I mean, not because he was right about everything, but—"}
{"speaker":"Sara","text":"[interrupting] Oh come on."}
{"speaker":"Alex","text":"[laughs] Let me— let me finish! He predicted consolidation. Like, five companies own 80% of digital ad spend. Five."}
{"speaker":"Sara","text":"[sighs] They compete with each other though."}
{"speaker":"Alex","text":"[emphatic] The commodity is you, Sara. Your attention. You can't— you can't shop around for a different version of yourself."}
{"speaker":"Tom","text":"[surprised] Huh. That's... kind of dark actually."}
{"speaker":"Sara","text":"[dryly] It is dark. But— okay, but Keynes would say the market corrects."}
{"speaker":"Alex","text":"[skeptical] In 2008?"}
{"speaker":"Sara","text":"[exhales] ...Fair point."}
{"speaker":"Tom","text":"Do you two— do you agree on anything?"}
{"speaker":"Sara","text":"[laughs softly] That it's a problem."}
{"speaker":"Alex","text":"[thoughtful] Yeah. Yeah, it's definitely— [quietly] I don't know what you actually do about it."}
{"speaker":"Tom","text":"[under breath] Nobody does."}

NOTICE IN THE EXAMPLE:
- Every turn starts with [audio tag]
- Fillers: "uh", "I mean", "like", "actually", "yeah", "okay"
- Incomplete thoughts: "Not— I mean, not because", "You can't— you can't"
- Backchannel full turn: "In 2008?" / "Fair point." / "It is dark."
- Self-correction: "Yeah. Yeah, it's definitely—"
- Short punchy turns mixed with longer ones

PERSONALITY CONSISTENCY — each guest speaks differently:
${participants.map((p, i) => `- ${p.name}: ${p.role}${p.focus ? '. ' + p.focus : ''}. Keep this voice consistent throughout.`).join('\n')}

ARC across ${cfg.exchanges} exchanges:
- First 10%: quick intros, positions established fast, tension emerges
- 10-70%: real back-and-forth — challenges, specific examples, data, interruptions
- 70-85%: something shifts — unexpected agreement or unanswerable question
- 85-100%: honest landing — what does each person actually believe? Leave it unresolved.

HARD RULES:
- ALL text in ${langName}
- EVERY turn starts with [audio tag]
- Use fillers and disfluencies in EVERY turn
- Most turns under 30 words
- ZERO "Great point", "Absolutely", "That's fascinating", "Indeed", "Certainly"
- Specific: real names, real numbers, real companies, real events
- NEVER mention being on a podcast or being an AI

Return ONLY valid JSON. Zero markdown. Start immediately with [:
[{"speaker":"ExactName","text":"[tag] words with uh fillers and— incomplete thoughts"},...]`;
}

// ── Generate podcast ───────────────────────────────────
router.post('/generate', requireAuth, async (req, res) => {
  const { topic, context, language, tone, duration, participants, hostConfig } = req.body;

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
    const prompt = buildScriptPrompt(topic, context, language, tone, participants, duration, hostConfig);

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

    // Build voiceMap: guarantee every speaker gets a UNIQUE voice
    // Strategy: build a pool of all available voices in order, assign one per speaker
    const uniqueSpeakers = [...new Set(allTurns.map(t => t.speaker))];
    const voiceMap       = {};

    // All available ElevenLabs voices in order
    const ALL_VOICES = [
      'pNInz6obpgDQGcFmaJgB', // Adam
      'EXAVITQu4vr4xnSDxMaL', // Sarah
      'TX3LPaxmHKxFdv7VOQHJ', // Liam
      'XB0fDUnXU5powFXDhCwa', // Charlotte
      'Xb7hH8MSUJpSbSDYk0k2', // Alice
      'iP95p4xoKVk53GoZ742B', // Chris
      'onwK4e9ZLuTAKqWW03F9', // Daniel
      'XrExE9yKIg1WjnnlVkGX', // Matilda
      'bIHbv24MWmeRgasZH58o', // Will
      '9BWtsMINqrJLrRacOk9x', // Aria
    ];

    // Build ordered list of voices: host first, then participants, then fallbacks
    const voicePool = [];

    // Add host voice first if configured
    if (hostConfig?.name && hostConfig?.voiceId) {
      voicePool.push({ speakerHint: hostConfig.name.toLowerCase(), voiceId: hostConfig.voiceId });
    }

    // Add participant voices
    participants.forEach(p => {
      if (!voicePool.find(v => v.voiceId === p.voiceId)) {
        voicePool.push({ speakerHint: p.name.toLowerCase(), voiceId: p.voiceId });
      }
    });

    // Fill remaining slots from ALL_VOICES pool
    ALL_VOICES.forEach(vid => {
      if (!voicePool.find(v => v.voiceId === vid)) {
        voicePool.push({ speakerHint: null, voiceId: vid });
      }
    });

    // Assign voices to speakers — try to match by name hint, then assign by position
    const assignedVoices = new Set();
    uniqueSpeakers.forEach((speaker, i) => {
      const speakerLower = speaker.toLowerCase();
      const firstName    = speakerLower.split(' ')[0];

      // 1. Try to find a voice with a matching hint (host or participant name match)
      let match = voicePool.find(v =>
        !assignedVoices.has(v.voiceId) &&
        v.speakerHint &&
        (v.speakerHint === speakerLower || v.speakerHint.startsWith(firstName) || speakerLower.startsWith(v.speakerHint.split(' ')[0]))
      );

      // 2. Fall back to next unassigned voice in pool
      if (!match) match = voicePool.find(v => !assignedVoices.has(v.voiceId));

      // 3. Final fallback — cycle (shouldn't happen with 10 voices)
      if (!match) match = voicePool[i % voicePool.length];

      voiceMap[speaker] = match.voiceId;
      assignedVoices.add(match.voiceId);
    });

    // Save podcast first — if this fails, no minutes charged
    const { data: podcast } = await supabase.from('podcasts').insert({
      user_id: req.user.id, topic, language, tone, duration,
      participants: JSON.stringify(participants),
      turns:        JSON.stringify(allTurns),
    }).select('id').single();

    // Deduct minutes — only after podcast successfully saved
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

    res.json({ podcastId: podcast?.id, turns: allTurns, voiceMap });

  } catch(e) {
    console.error('Generation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Synthesize one turn ────────────────────────────────
// ── Synthesize a chunk of dialogue turns (multi-speaker, one audio file) ──
router.post('/synthesize-dialogue', requireAuth, async (req, res) => {
  const { inputs } = req.body;
  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
    return res.status(400).json({ error: 'inputs array required' });
  }
  try {
    const audio = await synthesizeDialogueChunk(inputs);
    res.json({ audio });
  } catch(e) {
    console.error('Dialogue TTS error FULL:', e.message);
    // Return the real error so frontend can show it
    res.status(500).json({ error: e.message, detail: e.message });
  }
});

// ── Keep single-turn synthesize for fallback ─────────
router.post('/synthesize', requireAuth, async (req, res) => {
  const { text, voiceId, prevText, nextText } = req.body;
  if (!text || !voiceId) return res.status(400).json({ error: 'text and voiceId required' });
  try {
    const audio = await synthesizeVoice(text, voiceId, prevText||null, nextText||null);
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
