/* ============================================================
   Madinah · Command Deck — /api/coach
   ------------------------------------------------------------
   POST /api/coach { today, force? }
        → { review, digest, cached, runsLeft, nextDueAt }

   A weekly review: what you're failing on, what to do about it, and
   one thing that's genuinely working. Unlike /api/parse (Workers AI,
   effectively free) this calls Claude Opus 5 and costs real money, so
   the guards below are the point of the file, not an afterthought.

   Bindings (Cloudflare Pages → Settings):
     env.SYNC_TOKEN   secret (same token as /api/state)
     env.DB           D1 binding (binding name: DB)
     env.AI           Workers AI binding — the same one /api/parse uses

   Claude Opus 5 is reachable through Workers AI as a partner model, so
   there is no Anthropic API key here and no second credential to keep
   in sync: the binding authenticates the call. Billing is pass-through
   at Anthropic's own rates rather than out of the free Neuron
   allowance, which is why the spend guards below still matter.

   ── Why the state is read here, not sent ──────────────────────
   /api/parse is stateless and trusts the client's context because a
   bad payload there costs a fraction of a neuron. This endpoint reads
   D1 directly instead: the digest is computed from what is actually
   stored, and — more importantly — the rate limit lives next to the
   data it protects. A client bug that retried in a loop would
   otherwise bill Opus tokens until someone noticed.

   ── Cost ─────────────────────────────────────────────────────
   ~1k tokens in, ~600 out plus adaptive thinking ≈ $0.06 a review.
   Weekly, that's roughly £2.40/year. MAX_RUNS_PER_WEEK bounds the
   worst case if every manual refresh is used, every week, forever.
   ============================================================ */

import { buildDigest, digestFingerprint, isDateKey, metricsOf } from './digest.js';

const MODEL       = 'anthropic/claude-opus-5';
const MAX_TOKENS  = 2_000;
const AI_TIMEOUT_MS = 60_000; // Opus with adaptive thinking is not fast

const WEEK_MS            = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNS_PER_WEEK  = 3;   // one scheduled + two manual refreshes
const MIN_GAP_MS         = 60 * 60 * 1000; // no two reviews inside an hour
const MAX_NOTES          = 6;   // rolling memory carried between reviews
const MAX_HISTORY        = 8;   // past reviews kept, with their metrics, to measure against
const MAX_WRITE_ATTEMPTS = 3;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/* Constant-time token comparison via HMAC — see state.js for rationale */
const tokenOk = async (request, env) => {
  const header = request.headers.get('Authorization') || '';
  const given  = header.replace(/^Bearer\s+/i, '').trim();
  const expect = env.SYNC_TOKEN || '';
  if (!given || !expect) return false;

  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(given)),
    crypto.subtle.sign('HMAC', key, enc.encode(expect)),
  ]);
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
};

/* ── Spend guard ──────────────────────────────────────────────────
   Pure and exported so the rules are unit-tested rather than trusted.
   Returns why a call is refused, or null to allow it. ── */
export function checkAllowed(coach, { now, force, fingerprint }) {
  const runs = (coach?.runs || []).filter(t => now - t < WEEK_MS);
  const last = runs.length ? Math.max(...runs) : 0;

  if (runs.length >= MAX_RUNS_PER_WEEK) return { reason: 'weekly_limit', runs };
  if (last && now - last < MIN_GAP_MS)  return { reason: 'too_soon', runs };

  /* The scheduled path only fires once a week. A manual refresh skips
     that wait but still can't re-buy an identical review. */
  if (!force && last && now - last < WEEK_MS) return { reason: 'not_due', runs };
  if (coach?.fingerprint && coach.fingerprint === fingerprint) return { reason: 'unchanged', runs };

  return null;
}

export const runsLeftIn = (coach, now) =>
  Math.max(0, MAX_RUNS_PER_WEEK - (coach?.runs || []).filter(t => now - t < WEEK_MS).length);

/* ── The prompt ───────────────────────────────────────────────────
   The digest is finished arithmetic. The model is told not to compute
   anything, because a model doing sums over logs will invent a
   percentage and a review built on invented numbers is worse than no
   review. It prioritises, connects and phrases — nothing else. ── */
const SYSTEM = `You are the review voice inside someone's personal life-tracking system. You see one person's own data, weekly.

You are given a DIGEST of finished arithmetic. Every number in it is already computed and correct.

Rules:
- Never compute, estimate or invent a statistic. Quote only numbers present in the digest.
- If the digest is thin (little tracked, few tasks), say so plainly rather than manufacturing insight.
- Be direct and specific. No praise padding, no motivational filler, no therapy voice.
- "failing" means the evidence supports it. Two or three items, not a list of everything imperfect.
- Actions must be small enough to do this week and tied to something in the digest.
- "working" must be evidence-based. If nothing is genuinely going well, say that instead of inventing a win.
- British English. Second person. Roughly 130 words across all fields.

Continuity — this is the part that makes the review worth reading:
- digest.sinceLastReview holds the previous review's actions and note, and the measured change in each metric since. When it is present you MUST open by judging your own last advice: name what you told them to do and whether the number moved. Use "verdict" for this.
- Do not reissue an action that visibly worked. Do not silently drop one that did not — say it failed and either change the approach or say why it is still right.
- digest.filing counts how often the automatic task filing was overruled. A high correction rate is a finding in its own right: capture is fighting them, not serving them. Say so, and point at Configuration where the routing rules live.

Reply with a single JSON object and nothing else — no preamble, no code fence:
{"headline": string, "verdict": string, "failing": [{"area": string, "evidence": string, "why": string}], "actions": [{"action": string, "because": string}], "working": {"area": string, "evidence": string}, "note": string}`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One honest sentence on how the last 30 days actually went.' },
    verdict: {
      type: 'string',
      description: 'Whether last review\'s advice worked, naming the action and the measured change. Empty string only when there is no previous review.',
    },
    failing: {
      type: 'array',
      description: 'Two or three things going badly, each backed by a number from the digest.',
      items: {
        type: 'object',
        properties: {
          area:     { type: 'string', description: 'Short label, e.g. "Fajr" or "Overdue tasks".' },
          evidence: { type: 'string', description: 'The digest number that shows it.' },
          why:      { type: 'string', description: 'Why it matters, one clause.' },
        },
        required: ['area', 'evidence', 'why'],
        additionalProperties: false,
      },
    },
    actions: {
      type: 'array',
      description: 'Two or three concrete things to do this week.',
      items: {
        type: 'object',
        properties: {
          action:  { type: 'string', description: 'Imperative, specific, doable this week.' },
          because: { type: 'string', description: 'The digest fact it answers.' },
        },
        required: ['action', 'because'],
        additionalProperties: false,
      },
    },
    working: {
      type: 'object',
      description: 'One thing genuinely going well, or an honest statement that nothing stands out.',
      properties: {
        area:     { type: 'string' },
        evidence: { type: 'string' },
      },
      required: ['area', 'evidence'],
      additionalProperties: false,
    },
    note: { type: 'string', description: 'One line to carry into next week\'s review, so it can check whether this moved.' },
  },
  required: ['headline', 'verdict', 'failing', 'actions', 'working', 'note'],
  additionalProperties: false,
};

/* Structured outputs are not part of Workers AI's documented
   pass-through of the Anthropic messages format. `output_config` is
   still sent — if it is honoured the reply is schema-exact — but the
   shape is also stated in the prompt and the text is parsed
   defensively, so the review works either way rather than 502-ing on
   an undocumented parameter being dropped. */
export function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('NO_JSON_IN_REPLY');
  return JSON.parse(text.slice(start, end + 1));
}

async function askClaude(digest, notes, env) {
  const call = env.AI.run(MODEL, {
    max_tokens: MAX_TOKENS,
    /* Opus 5 calibrates its own reasoning per task; passing a fixed
       budget is rejected outright on this model family. */
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        notes?.length
          ? `Notes you left after previous reviews (most recent last):\n${notes.map(n => `- ${n}`).join('\n')}`
          : 'No previous reviews — this is the first, so leave "verdict" empty.',
        '',
        'DIGEST:',
        JSON.stringify(digest, null, 1),
      ].join('\n'),
    }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  });

  /* env.AI.run takes no abort signal, and a review is a foreground
     action behind a spinner — cap the wait rather than let the request
     hold the button hostage. */
  const body = await Promise.race([
    call,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), AI_TIMEOUT_MS)),
  ]);

  /* Adaptive thinking puts a thinking block first, so find the text
     block rather than assuming index 0. */
  const text = body?.content?.find(c => c.type === 'text')?.text;
  if (!text) throw new Error('NO_TEXT_BLOCK');
  return { review: extractJson(text), usage: body.usage || null };
}

/* Merge the coach result into the stored state under optimistic
   concurrency, same as /api/state — a review must not clobber edits
   made while the model was thinking. */
async function persist(env, patch) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare('SELECT data, updated_at FROM state WHERE id = 1').first();
    let data = {};
    try { data = row?.data ? JSON.parse(row.data) : {}; } catch {}
    const prevUpdated = row?.updated_at ?? 0;

    const next = { ...data, coach: patch(data.coach) };
    const now  = Math.max(Date.now(), prevUpdated + 1);
    const result = await env.DB.prepare(
      'UPDATE state SET data = ?, updated_at = ? WHERE id = 1 AND updated_at = ?'
    ).bind(JSON.stringify(next), now, prevUpdated).run();

    if (result.meta.changes > 0) return next.coach;
  }
  return null;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.DB) return json({ error: 'not_configured', detail: 'DB binding missing' }, 500);

  /* Every path below can throw on a first-ever run — a fresh D1 write
     shape, a digest built from whatever malformed state has drifted in
     over every version of this app. An uncaught throw here returns a
     bare Cloudflare error page, not JSON: the client can't parse it,
     falls through every specific case, and reports a useless "could
     not reach the service" for what might be a one-line D1 error. See
     state.js for the same wrapper. */
  try {
    let body = {};
    try { body = await request.json(); } catch {}
    const force = body?.force === true;

    const row = await env.DB.prepare('SELECT data FROM state WHERE id = 1').first();
    let state = {};
    try { state = row?.data ? JSON.parse(row.data) : {}; } catch {}

    const today  = isDateKey(body?.today) ? body.today : new Date().toISOString().slice(0, 10);
    const digest = buildDigest(state, today);
    const fingerprint = digestFingerprint(digest);
    const coach = state.coach || null;
    const now = Date.now();

    const blocked = checkAllowed(coach, { now, force, fingerprint });
    if (blocked) {
      /* Not an error — the stored review is still the current answer. */
      return json({
        review: coach?.review || null,
        digest, cached: true, reason: blocked.reason,
        at: coach?.at || null,
        runsLeft: runsLeftIn(coach, now),
        nextDueAt: coach?.at ? coach.at + WEEK_MS : null,
      });
    }

    if (!env.AI) return json({ error: 'not_configured', detail: 'AI binding missing' }, 500);

    let review, usage;
    try {
      ({ review, usage } = await askClaude(digest, coach?.notes || [], env));
    } catch (err) {
      /* Nothing is written and no run is recorded, so a failure costs
         the user neither money nor their weekly allowance. */
      console.error('coach: review failed —', err?.message || err);
      return json({ error: 'review_failed', detail: String(err?.message || err).slice(0, 200) }, 502);
    }

    const saved = await persist(env, (prev) => ({
      at: now,
      review,
      fingerprint,
      runs: [...(prev?.runs || []).filter(t => now - t < WEEK_MS), now],
      notes: [...(prev?.notes || []), review.note].slice(-MAX_NOTES),
      /* The metrics as they stood when this advice was given. Next
         review diffs against them, which is what lets it judge
         whether what it told you to do actually worked. */
      history: [...(prev?.history || []), {
        at: now,
        note: review.note,
        actions: (review.actions || []).map(a => a.action),
        metrics: metricsOf(digest),
      }].slice(-MAX_HISTORY),
    }));

    return json({
      review, digest, cached: false, usage,
      at: now,
      runsLeft: runsLeftIn(saved, now),
      nextDueAt: now + WEEK_MS,
    });
  } catch (err) {
    console.error('coach handler error:', err);
    return json({ error: 'internal_error', detail: String(err?.message || err).slice(0, 200) }, 500);
  }
}
