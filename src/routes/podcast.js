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
  // Per ElevenLabs v3 docs:
  // - Use eleven_v3 model for maximum expressiveness with audio tags
  // - stability: Natural mode (0.50) = closest to original voice, balanced
  //   Creative (~0.30) = more expressive but prone to hallucination
  //   Robust (~0.75) = consistent but LESS responsive to audio tags (avoid for v3)
  // - similarity_boost: 0.75 is the documented sweet spot
  // - style: 0 — let TEXT and AUDIO TAGS drive emotion, not this slider
  // - previous_text/next_text: critical for natural prosody between turns
  const body = {
    text,
    model_id: 'eleven_v3',
    voice_settings: {
      stability:         0.50,   // Natural mode — responsive to tags, stable
      similarity_boost:  0.75,   // Sweet spot per docs
      style:             0,      // Tags drive emotion, not this
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

  // Apply v3-optimised prompt engineering per ElevenLabs documentation:
  // - Min 250 chars per turn for stable generation
  // - Expressive punctuation (ellipses, em dashes) shapes delivery
  // - Audio tags [laughs], [sighs] etc. as performance directions
  // - Capitalise for emphasis
  // - Natural speech rhythms, emotional highs and lows
  // - For dialogue: [curious], [giggling], [dramatic pause] etc.
  return `Write a COMPLETE ${duration}-minute ${tone.toLowerCase()} podcast in ${langName}.

Topic: "${topic}"
${context ? `Background:\n${context}\n` : ''}
${hostLine}Guests:
${guestList}

TARGET: ${cfg.exchanges} exchanges. Write ALL of them.

━━━ ELEVENLABS ELEVEN_V3 AUDIO DIRECTION ━━━
[tags] = PERFORMANCE DIRECTIONS, never spoken aloud.
Tags apply until the next pause/sentence break.
COMBINE TAGS for richer delivery: [fast-paced, frustrated] or [quietly, hesitant]

COMPLETE TAG LIBRARY — use ALL of these appropriately:

EMOTIONS:
[excited] [frustrated] [nervous] [tired] [sad] [angry] [happy] [curious]
[skeptical] [resigned] [surprised] [relieved] [annoyed] [flustered] [sarcastic]
[deadpan] [passionate] [disgusted] [amused] [confused] [mischievously]

DELIVERY / PACE:
[fast-paced] [drawn out] [whispers] [shouts] [quietly] [emphatically]
[hesitates] [stammers] [flatly] [dryly] [playfully] [cheerfully] [solemnly]

REACTIONS / SOUNDS:
[laughs] [chuckles] [sighs] [exhales sharply] [gasps] [gulps] [scoffs]
[nervous laugh] [bitter laugh] [snorts] [tuts] [groans]

SITUATIONAL:
[interrupting] [leaning in] [trailing off] [under breath] [as if realizing]
[catching themselves] [building momentum] [losing steam] [holding back]

━━━ HOW EMOTIONS SHIFT MID-SENTENCE ━━━
This is the KEY to sounding human. Tags shift within a single turn.

HEATED MOMENT (pace accelerates, emotions spike):
"[fast-paced, frustrated] No— that's not— that's completely wrong. [emphatically] Five companies. FIVE. [quieter, catching themselves] You're telling me that's not consolidation?"

DEFLATION (energy drops mid-thought):
"[excited] The Fed intervention worked, right? It prevented— [trailing off] I mean... [sighs, quietly] kind of. Sort of. [resigned] Not really."

REALIZATION MID-SENTENCE:
"[skeptical] I don't think that's— [pause] [as if realizing] wait, actually. Actually that's exactly— [building momentum] that's EXACTLY what Marx predicted."

LAUGHTER THAT TURNS SERIOUS:
"[laughs] Okay, okay, that's— [catching themselves] no but actually, that's— [solemnly] that's a genuinely terrifying point."

WHEN DEBATE GETS HEATED — these patterns appear in real interviews:
- Pace accelerates: [fast-paced] tags, shorter sentences, more interruptions
- People talk over each other more: more [interrupting] tags
- Volume changes: mix [shouts] with [quieter] within same exchange
- Frustration builds: [frustrated] → [emphatically] → [losing steam] arc
- Then someone laughs to defuse: [nervous laugh] or [chuckles, deflecting]

━━━ CONVERSATION STRUCTURE ━━━

HOST OPENING (first 2-3 exchanges if host exists):
${hostLine ? `The host (${hostLine.split(':')[1]?.trim().split('\n')[0] || 'host'}) opens with a warm, natural intro — not formal. Like:
"[cheerfully] Alright, so— today we're getting into something that I think is genuinely fascinating. [leaning in] ${topic.slice(0,60)}. I've got [guests names] here and I— honestly I have no idea where this goes. [playfully] Let's find out."
Then briefly introduces each guest naturally, not reading a CV.` : ''}

MAIN CONVERSATION DYNAMICS:
- Opening 10%: positions staked fast, tension emerges immediately
- 10-50%: building heat — challenges, data, examples, pace accelerating  
- 50-70%: peak tension — interruptions, [fast-paced] tags, emotional spikes
- 70-85%: a shift — unexpected agreement OR an unanswerable question lands
- 85-95%: honest landing — what does each person actually believe?
${hostLine ? `- Last 2-3 exchanges: host wraps up naturally: "[thoughtfully] So here's what I'm taking away from this... [to guests] Quick final thought each of you?" Then genuine thank you, not formal.` : ''}

REAL INTERVIEW PATTERNS (from Rogan, Fridman, debate transcripts):
1. People reference exact words just said: "[skeptical] 'Five companies'— okay. Which five specifically?"
2. Laughter appears at unexpected moments, often at serious points
3. Someone admits uncertainty: "[hesitates] I... I don't know if that's right actually"
4. Energy builds then someone deflates it: "[laughs, deflecting] okay okay I'm being too intense"
5. Tangents feel natural: "— which reminds me of something completely unrelated but— [fast-paced] actually no it's totally related"
6. Silences in text: "..." signals the voice to pause naturally

FILLERS THAT MAKE SPEECH HUMAN (use constantly):
"uh", "um", "I mean", "you know", "like", "well", "so", "right", "okay"
"it's— it's weird", "I uh— yeah", "that's— that's not", "well I— no"

EXAMPLE SHOWING EMOTIONAL ARC (study the tag progression):
{"speaker":"Tom","text":"[cheerfully, leaning in] Alright. So— uh, Marx versus Keynes in 2025. Who wins?"}
{"speaker":"Alex","text":"[without hesitation] Marx."}
{"speaker":"Sara","text":"[scoffs] Oh come ON."}
{"speaker":"Alex","text":"[laughs] Let me— [fast-paced] He predicted consolidation. Five companies own 80% of digital ad spend. Five."}
{"speaker":"Sara","text":"[flatly] They compete with each other."}
{"speaker":"Alex","text":"[emphatically] The commodity is YOU, Sara. [building momentum] Your attention, your data— [catching themselves, quieter] you can't shop around for a different version of yourself."}
{"speaker":"Tom","text":"[surprised, quietly] Huh. That's... kind of dark."}
{"speaker":"Sara","text":"[sighs] It is dark. But— [hesitates] Keynes would say the market corrects eventually."}
{"speaker":"Alex","text":"[fast-paced, frustrated] In 2008?! The top 1%— [stops, exhales sharply] sorry. [resigned] Go on."}
{"speaker":"Sara","text":"[nervous laugh] No, that's— that's fair. [trailing off] 2008 is... yeah."}
{"speaker":"Tom","text":"[amused] Do you two agree on anything at all?"}
{"speaker":"Sara","text":"[deadpan] That it's a problem."}
{"speaker":"Alex","text":"[laughs, then quietly] Yeah. It's a problem. I just... [as if realizing] I genuinely don't know what you do about it."}
{"speaker":"Tom","text":"[solemnly] Nobody does. [pause] That might be the most honest thing said today."}

HARD RULES:
- ALL text in ${langName}
- EVERY turn has at least one [tag], most have 2-3 with mid-sentence shifts
- Fillers in every turn
- Most turns under 30 words
- ZERO "Great point", "Absolutely", "That's fascinating", "Indeed"
- Real specifics: names, numbers, companies, events
- NEVER mention being a podcast or AI

Return ONLY valid JSON, zero markdown:
[{"speaker":"ExactName","text":"[tag, tag] words uh— shifting [new tag] mid sentence"},...]`;
}

// ── Build series episode prompt ───────────────────────
function buildSeriesEpisodePrompt(topic, context, langCode, tone, participants, duration, hostConfig, seriesMeta) {
  const { totalEpisodes, episodeNumber, seriesTitle, seriesArc, prevSummary, nextEpisodeHint } = seriesMeta;
  const langName  = LANG_NAMES[langCode] || 'English';
  const cfg       = DURATION_CFG[duration] || DURATION_CFG[15];
  const guestList = participants.map(p =>
    `- ${p.name} (${p.role})${p.focus ? ' — angle: ' + p.focus : ''}`
  ).join('\n');
  const hostLine  = hostConfig && hostConfig.name
    ? `Host (guides discussion, does NOT debate): ${hostConfig.name}\n`
    : '';

  return `Write Episode ${episodeNumber} of ${totalEpisodes} of a podcast series titled "${seriesTitle}" in ${langName}.

SERIES OVERVIEW:
${seriesArc}

THIS EPISODE: Episode ${episodeNumber} — ${topic}
${context ? `Source material for this episode:\n${context}\n` : ''}
${hostLine}Guests:
${guestList}

${prevSummary ? `PREVIOUS EPISODE RECAP (Episode ${episodeNumber - 1}):\n${prevSummary}\nThe host MUST briefly reference this at the start to connect the series.` : ''}

${nextEpisodeHint ? `NEXT EPISODE PREVIEW: The series will move on to: ${nextEpisodeHint}\nThe host MUST tease this at the end.` : ''}

TARGET: ${cfg.exchanges} exchanges. Write ALL of them.

SERIES EPISODE STRUCTURE:
${episodeNumber === 1 ? `SERIES OPENER: Host introduces the entire series concept first (2-3 exchanges), then this episode's topic. Set up what the whole series will explore.` : episodeNumber === totalEpisodes ? `SERIES FINALE: This is the last episode. Host should bring together threads from the whole series. End with a reflection on the full journey.` : `MID-SERIES: Open by briefly referencing where we left off. End by hinting at the next episode.`}

━━━ ELEVENLABS ELEVEN_V3 AUDIO DIRECTION ━━━
[tags] = PERFORMANCE DIRECTIONS. Use layered tags for emotional arcs.

COMPLETE v3 TAG LIBRARY (from official ElevenLabs docs):
VOICE: [whispers] [shouts] [fast-paced] [drawn out] [emphatically] [quietly] [flatly] [dryly]
EMOTION: [excited] [frustrated] [nervous] [sad] [angry] [curious] [skeptical] [resigned]
         [surprised] [relieved] [annoyed] [sarcastic] [deadpan] [passionate] [amused]
SOUNDS: [laughs] [chuckles] [sighs] [exhales sharply] [gasps] [scoffs] [coughs] [snorts]
         [nervous laugh] [bitter laugh] [clears throat]
DELIVERY: [hesitates] [stammers] [interrupting] [leaning in] [trailing off] [under breath]
          [as if realizing] [building momentum] [catching themselves] [dramatic pause]

4. CAPITALISE for strong emphasis: "That is EXACTLY the problem." / "I had NO idea."
5. NATURAL SPEECH RHYTHMS — short punchy sentences mixed with longer ones
6. EMOTIONAL HIGHS AND LOWS — every exchange should have dynamic range

EMOTIONAL ARCS — shift tags MID-SENTENCE:
"[fast-paced, frustrated] No— that's not— [emphatically] completely wrong. [catching themselves, quieter] Sorry. Go on."
"[excited] This is— wait. [as if realizing] This is exactly what happened in episode ${episodeNumber - 1 || 1}."

CONVERSATION DYNAMICS:
- Fillers in every turn: "uh", "I mean", "you know", "like", "well"
- Incomplete thoughts: "It's— it's complicated", "The thing is—"
- Short reactive turns: "[scoffs] Right." / "[sighs] Yeah." / "[surprised] Wait, what?"
- Every turn starts with at least one [audio tag]
- Most turns under 30 words

RULES:
- ALL text in ${langName}
- NEVER "Great point", "Absolutely", "That's fascinating"
- Real specifics: names, dates, places, events from the source material
- Each guest keeps consistent personality across ALL episodes in the series

Return ONLY valid JSON:
[{"speaker":"ExactName","text":"[tag] words"},...]`;
}

// ── Generate series plan ───────────────────────────────
async function generateSeriesPlan(topic, context, totalEpisodes, tone, langCode) {
  const langName = LANG_NAMES[langCode] || 'English';
  const prompt = `You are planning a ${totalEpisodes}-episode podcast series on: "${topic}"
${context ? `Source material:\n${context}\n` : ''}
Tone: ${tone}
Language: ${langName}

Create a compelling series arc — like a TV series or documentary, not random episodes.
Each episode should build on the previous. There should be a clear narrative journey.

Return ONLY valid JSON:
{
  "seriesTitle": "compelling series title",
  "seriesLogline": "one sentence describing the whole series arc",
  "seriesArc": "2-3 sentences describing the narrative journey across all episodes",
  "episodes": [
    {
      "episodeNumber": 1,
      "title": "episode title",
      "focus": "what this episode specifically covers",
      "keyTension": "the central question or conflict this episode explores",
      "endsOn": "what cliffhanger or thought this episode ends on"
    }
  ]
}`;

  const raw = await callAnthropic(
    'You are a podcast series producer. Return only valid JSON.',
    [{ role:'user', content: prompt }],
    2000
  );
  const clean = raw.replace(/```json|```/g,'').trim();
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  return JSON.parse(clean.slice(start, end+1));
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

// ── Plan a series (returns episode outline, no audio) ──
router.post('/plan-series', requireAuth, async (req, res) => {
  const { topic, context, totalEpisodes, tone, language } = req.body;
  if (!topic || !totalEpisodes) return res.status(400).json({ error: 'topic and totalEpisodes required' });
  try {
    const plan = await generateSeriesPlan(topic, context, totalEpisodes, tone || 'Debate', language || 'en');
    res.json({ plan });
  } catch(e) {
    console.error('Series plan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Generate one episode of a series ───────────────────
router.post('/generate-episode', requireAuth, async (req, res) => {
  const { topic, context, language, tone, duration, participants, hostConfig, seriesMeta } = req.body;
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
    const prompt = buildSeriesEpisodePrompt(topic, context, language, tone, participants, duration, hostConfig, seriesMeta);
    const cfg    = DURATION_CFG[duration] || DURATION_CFG[15];
    const raw    = await callAnthropic(
      'You are a professional podcast scriptwriter for a multi-episode series.',
      [{ role:'user', content: prompt }],
      cfg.maxTokens
    );

    const clean = raw.replace(/```json|```/g,'').trim();
    const start = clean.indexOf('[');
    const end   = clean.lastIndexOf(']');
    if (start === -1) throw new Error('No script returned');

    let allTurns = JSON.parse(clean.slice(start, end+1));
    allTurns = allTurns.filter(t => t.speaker && t.text?.trim()).map(t => ({ speaker: t.speaker.trim(), text: t.text.trim() }));
    if (allTurns.length < 5) throw new Error('Script too short — please try again');

    // Build voiceMap
    const uniqueSpeakers = [...new Set(allTurns.map(t => t.speaker))];
    // v3-optimised stock voices — IVC voices respond best to audio tags per ElevenLabs docs
    const ALL_VOICES = ['JBFqnCBsd6RMkjVDRZzb','EXAVITQu4vr4xnSDxMaL','TX3LPaxmHKxFdv7VOQHJ','XB0fDUnXU5powFXDhCwa','pFZP5JQG7iQjIQuC4Bku','onwK4e9ZLuTAKqWW03F9','XrExE9yKIg1WjnnlVkGX','CwhRBWXzGAHq8TQ4Fs17','SAz9YHcvj6GT2YYXdXww','9BWtsMINqrJLrRacOk9x'];
    const voicePool = [];
    if (hostConfig?.name && hostConfig?.voiceId) voicePool.push({ speakerHint: hostConfig.name.toLowerCase(), voiceId: hostConfig.voiceId });
    participants.forEach(p => { if (!voicePool.find(v => v.voiceId === p.voiceId)) voicePool.push({ speakerHint: p.name.toLowerCase(), voiceId: p.voiceId }); });
    ALL_VOICES.forEach(vid => { if (!voicePool.find(v => v.voiceId === vid)) voicePool.push({ speakerHint: null, voiceId: vid }); });
    const assignedVoices = new Set();
    const voiceMap = {};
    uniqueSpeakers.forEach((speaker, i) => {
      const sl = speaker.toLowerCase();
      const fn = sl.split(' ')[0];
      let match = voicePool.find(v => !assignedVoices.has(v.voiceId) && v.speakerHint && (v.speakerHint === sl || v.speakerHint.startsWith(fn) || sl.startsWith(v.speakerHint.split(' ')[0])));
      if (!match) match = voicePool.find(v => !assignedVoices.has(v.voiceId));
      if (!match) match = voicePool[i % voicePool.length];
      voiceMap[speaker] = match.voiceId;
      assignedVoices.add(match.voiceId);
    });

    // Save episode
    const { data: podcast } = await supabase.from('podcasts').insert({
      user_id: req.user.id, topic, language, tone, duration,
      participants: JSON.stringify(participants),
      turns: JSON.stringify(allTurns),
      series_title:   seriesMeta?.seriesTitle || null,
      series_id:      seriesMeta?.seriesId    || null,
      episode_number: seriesMeta?.episodeNumber || null,
    }).select('id').single();

    // Deduct minutes after successful save
    const plan = PLANS[req.user.subscription_plan];
    if (!plan) {
      const freeLeft = freeMinutesRemaining(req.user);
      if (freeLeft >= duration) {
        await supabase.from('users').update({ free_minutes_used: (req.user.free_minutes_used||0)+duration }).eq('id',req.user.id);
      } else {
        await supabase.from('users').update({ free_minutes_used: (req.user.free_minutes_used||0)+freeLeft, minutes_topup: Math.max(0,(req.user.minutes_topup||0)-(duration-freeLeft)) }).eq('id',req.user.id);
      }
    } else {
      const periodStart = new Date(req.user.period_start);
      const now = new Date();
      const monthsElapsed = (now.getFullYear()-periodStart.getFullYear())*12+(now.getMonth()-periodStart.getMonth());
      if (monthsElapsed > 0) {
        await supabase.from('users').update({ minutes_used: duration, period_start: now.toISOString() }).eq('id',req.user.id);
      } else {
        const planRemaining = Math.max(0, plan.minutesPerPeriod - (req.user.minutes_used||0));
        if (duration <= planRemaining) {
          await supabase.from('users').update({ minutes_used: (req.user.minutes_used||0)+duration }).eq('id',req.user.id);
        } else {
          await supabase.from('users').update({ minutes_used: plan.minutesPerPeriod, minutes_topup: Math.max(0,(req.user.minutes_topup||0)-(duration-planRemaining)) }).eq('id',req.user.id);
        }
      }
    }

    res.json({ podcastId: podcast?.id, turns: allTurns, voiceMap });
  } catch(e) {
    console.error('Episode generation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Voice preview proxy ───────────────────────────────
router.get('/voice-preview/:voiceId', async (req, res) => {
  const { voiceId } = req.params;
  const url = `https://storage.googleapis.com/eleven-public-prod/premade/voices/${voiceId}/preview.mp3`;
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(404).json({ error: 'Preview not found' });
    const buffer = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch(e) {
    console.error('Voice preview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Voice cloning: create instant voice clone ────────
router.post('/clone-voice', requireAuth, async (req, res) => {
  // Creates an Instant Voice Clone (IVC) — the correct type for eleven_v3
  // Per ElevenLabs docs: PVCs are NOT optimised for v3. Use IVC for best results.
  // IVC works immediately, no training required.
  const fetch2 = require('node-fetch');
  const FormData = require('form-data');

  const { name, description } = req.body;
  const audioData = req.body.audioBase64;
  const audioName = req.body.audioName || 'sample.mp3';

  if (!name || !audioData) return res.status(400).json({ error: 'name and audioBase64 required' });

  try {
    const form = new FormData();
    form.append('name', name);
    // v3-optimised description — helps ElevenLabs understand intended delivery
    const v3Desc = `${description || 'Custom voice'}. Optimised for conversational podcast delivery with emotional range. IVC for eleven_v3.`;
    form.append('description', v3Desc);
    const audioBuffer = Buffer.from(audioData, 'base64');
    form.append('files', audioBuffer, { filename: audioName, contentType: 'audio/mpeg' });
    form.append('remove_background_noise', 'true');
    // labels help with v3 performance
    form.append('labels', JSON.stringify({ use_case: 'podcast', optimised_for: 'eleven_v3' }));

    const r = await fetch2('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, ...form.getHeaders() },
      body: form,
    });

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: e.detail?.message || `ElevenLabs error ${r.status}` });
    }

    const data = await r.json();
    // Save voice to user's profile
    await supabase.from('user_voices').insert({
      user_id:  req.user.id,
      voice_id: data.voice_id,
      name,
      description: description || '',
    });

    res.json({ voiceId: data.voice_id, name });
  } catch(e) {
    console.error('Voice clone error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Get user's cloned voices ──────────────────────────
router.get('/my-voices', requireAuth, async (req, res) => {
  const { data } = await supabase.from('user_voices')
    .select('voice_id, name, description, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  res.json({ voices: data || [] });
});

// ── Edit a turn: regenerate single turn audio ────────
router.post('/edit-turn', requireAuth, async (req, res) => {
  const { podcastId, turnIndex, newText, voiceId } = req.body;
  if (!podcastId || turnIndex === undefined || !newText || !voiceId) {
    return res.status(400).json({ error: 'podcastId, turnIndex, newText, voiceId required' });
  }

  try {
    // Get the podcast
    const { data: podcast } = await supabase.from('podcasts')
      .select('turns, edit_count, user_id')
      .eq('id', podcastId)
      .eq('user_id', req.user.id)
      .single();

    if (!podcast) return res.status(404).json({ error: 'Podcast not found' });

    const editCount   = podcast.edit_count || 0;
    const FREE_EDITS  = 5; // first 5 edits per month are free
    const EDIT_COST   = 1; // 1 minute per edit after free quota

    // Check if user has minutes for paid edit
    if (editCount >= FREE_EDITS) {
      const check = canGeneratePodcast(req.user, EDIT_COST);
      if (!check.allowed) {
        return res.status(403).json({
          error:      'insufficient_minutes',
          remaining:  check.remaining || 0,
          editCount,
          freeEdits:  FREE_EDITS,
          message:    `You've used your ${FREE_EDITS} free edits. This edit costs 1 minute from your plan.`,
        });
      }
    }

    // Synthesize the new turn
    const audio = await synthesizeVoice(newText, voiceId);

    // Update the podcast turns
    const turns = JSON.parse(podcast.turns || '[]');
    if (turns[turnIndex]) turns[turnIndex] = { ...turns[turnIndex], text: newText };

    await supabase.from('podcasts').update({
      turns:      JSON.stringify(turns),
      edit_count: editCount + 1,
    }).eq('id', podcastId);

    // Deduct minute if past free quota
    if (editCount >= FREE_EDITS) {
      const plan = PLANS[req.user.subscription_plan];
      if (!plan) {
        const freeLeft = freeMinutesRemaining(req.user);
        if (freeLeft >= EDIT_COST) {
          await supabase.from('users').update({ free_minutes_used: (req.user.free_minutes_used||0)+EDIT_COST }).eq('id',req.user.id);
        } else {
          await supabase.from('users').update({ minutes_topup: Math.max(0,(req.user.minutes_topup||0)-EDIT_COST) }).eq('id',req.user.id);
        }
      } else {
        await supabase.from('users').update({ minutes_used: (req.user.minutes_used||0)+EDIT_COST }).eq('id',req.user.id);
      }
    }

    res.json({
      audio,           // base64 audio for this turn
      editCount:  editCount + 1,
      freeEdits:  FREE_EDITS,
      wasFreeEdit: editCount < FREE_EDITS,
    });
  } catch(e) {
    console.error('Edit turn error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── RSS Feed — generates a valid podcast RSS feed ────
router.get('/rss/:userId', async (req, res) => {
  const { userId } = req.params;
  const { data: user } = await supabase.from('users').select('email').eq('id', userId).single();
  if (!user) return res.status(404).send('User not found');

  // Only serve podcasts the user has explicitly chosen to publish
  const { data: podcasts } = await supabase.from('podcasts')
    .select('id, topic, language, tone, duration, created_at, series_title, episode_number, published_title, published_description')
    .eq('user_id', userId)
    .eq('published', true)
    .order('published_at', { ascending: false })
    .limit(50);

  const baseUrl  = process.env.FRONTEND_URL || 'https://podcast-studio.vercel.app';
  const feedUrl  = `${process.env.RAILWAY_URL || 'https://podcast-studio-backend-production.up.railway.app'}/podcast/rss/${userId}`;
  const now      = new Date().toUTCString();

  const items = (podcasts || []).map(p => {
    const audioUrl = `${baseUrl}/studio?id=${p.id}`;
    const pubDate  = new Date(p.created_at).toUTCString();
    const title    = p.series_title ? `${p.series_title} — Ep ${p.episode_number}: ${p.topic}` : p.topic;
    const desc     = `A ${p.duration}-minute AI-generated ${p.tone.toLowerCase()} podcast on: ${p.topic}`;
    return `
    <item>
      <title><![CDATA[${title}]]></title>
      <description><![CDATA[${desc}]]></description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${p.id}</guid>
      <link>${audioUrl}</link>
      <enclosure url="${audioUrl}" length="0" type="audio/mpeg"/>
      <itunes:duration>${p.duration}:00</itunes:duration>
      <itunes:title><![CDATA[${title}]]></itunes:title>
      <itunes:summary><![CDATA[${desc}]]></itunes:summary>
      <itunes:explicit>no</itunes:explicit>
    </item>`;
  }).join('');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>AI Podcast Studio — My Podcasts</title>
    <link>${baseUrl}</link>
    <description>AI-generated podcasts created with AI Podcast Studio</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <itunes:author>AI Podcast Studio</itunes:author>
    <itunes:explicit>no</itunes:explicit>
    <itunes:image href="${baseUrl}/podcast-cover.jpg"/>
    <itunes:category text="Technology"/>
    ${items}
  </channel>
</rss>`;

  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(rss);
});

// ── Publish / unpublish a podcast episode ────────────
router.post('/publish-episode', requireAuth, async (req, res) => {
  const { podcastId, publish, title, description } = req.body;
  if (!podcastId) return res.status(400).json({ error: 'podcastId required' });

  const { data: podcast } = await supabase.from('podcasts')
    .select('id, user_id, topic')
    .eq('id', podcastId)
    .eq('user_id', req.user.id)
    .single();

  if (!podcast) return res.status(404).json({ error: 'Podcast not found' });

  await supabase.from('podcasts').update({
    published:             publish,
    published_at:          publish ? new Date().toISOString() : null,
    published_title:       title       || podcast.topic,
    published_description: description || null,
  }).eq('id', podcastId);

  res.json({ published: publish });
});

// ── Get user's RSS feed URL ───────────────────────────
router.get('/my-rss-url', requireAuth, async (req, res) => {
  const railwayUrl = process.env.RAILWAY_URL || 'https://podcast-studio-backend-production.up.railway.app';
  res.json({ feedUrl: `${railwayUrl}/podcast/rss/${req.user.id}` });
});

// ── History ────────────────────────────────────────────
router.get('/history', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('podcasts')
    .select('id, topic, language, tone, duration, created_at, published, published_at, published_title')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
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
