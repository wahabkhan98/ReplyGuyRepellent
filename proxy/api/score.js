// POST /api/score — scores replies with Jev via the TypeSafe API. The key never leaves this function.

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const MAX_REPLIES = 20;
const TEXT_MAX = 1000;
const CALL_TIMEOUT_MS = 3000;
const MAX_RETRY_WAIT_MS = 3000;

const QUESTION = {
  lowEffort: {
    type: 'score',
    instructions: 'How generic and low-effort is this reply to the post? Judge the writing, not who wrote it.',
    criteria: ['Specific and engaged with the post', 'Somewhat generic', 'Could be pasted under any post'],
  },
};

let warnedNoLimiter = false;
let warnedBadKey = false;
let limiterPromise = null;

// ---------- Rate limit: 60 requests / minute / IP, only when Upstash is configured ----------

function getLimiter() {
  if (limiterPromise) return limiterPromise;
  const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
  if (!url || !token) {
    if (!warnedNoLimiter) {
      warnedNoLimiter = true;
      console.warn('[score] UPSTASH_REDIS_REST_URL/TOKEN not set; rate limiting is OFF.');
    }
    limiterPromise = Promise.resolve(null);
    return limiterPromise;
  }
  limiterPromise = Promise.all([import('@upstash/ratelimit'), import('@upstash/redis')])
    .then(([{ Ratelimit }, { Redis }]) => new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(60, '1 m'),
      prefix: 'rgr',
    }))
    .catch((err) => {
      console.warn('[score] Could not load Upstash rate limiter; rate limiting is OFF.', err.message);
      return null;
    });
  return limiterPromise;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
}

// ---------- CORS: chrome-extension:// origins only ----------

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

// ---------- Validation ----------

function parseBody(body) {
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || typeof body !== 'object') return null;
  const { post, replies } = body;
  if (typeof post !== 'string' || !Array.isArray(replies)) return null;
  if (replies.length < 1 || replies.length > MAX_REPLIES) return null;
  for (const r of replies) {
    if (!r || typeof r.id !== 'string' || typeof r.text !== 'string' || !r.id) return null;
  }
  return {
    post: post.slice(0, TEXT_MAX),
    replies: replies.map((r) => ({ id: r.id, text: r.text.slice(0, TEXT_MAX) })),
  };
}

// ---------- TypeSafe calls ----------

class CallError extends Error {
  constructor(status, detail) {
    super(`TypeSafe ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

function retryAfterMs(res, body) {
  const fromBody = Number(body?.retry_after ?? body?.error?.retry_after);
  const fromHeader = Number(res.headers.get('retry-after'));
  const secs = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 1;
  return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
}

async function callOnce(key, post, reply) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: { post, reply: reply.text }, questions: QUESTION }),
      signal: ctrl.signal,
    });
    const body = await readJson(res);
    if (res.status === 200) return body;
    throw new CallError(res.status, { body, retryMs: res.status === 429 ? retryAfterMs(res, body) : 0 });
  } finally {
    clearTimeout(timer);
  }
}

async function scoreReply(key, post, reply) {
  let body;
  try {
    body = await callOnce(key, post, reply);
  } catch (err) {
    if (err.status !== 429) throw err;
    await sleep(err.detail.retryMs);
    body = await callOnce(key, post, reply); // one retry, then it counts as failed
  }
  const a = body?.answers?.lowEffort;
  if (typeof a?.score !== 'number' || typeof a?.confidence !== 'number') throw new CallError('bad-shape');
  return {
    id: reply.id,
    score: Math.min(2, Math.max(0, a.score)),
    confidence: Math.min(1, Math.max(0, a.confidence)),
  };
}

// Never log reply text; only ids, statuses and TypeSafe's own error bodies.
function logFailure(err, id) {
  if (err.status === 401) {
    if (!warnedBadKey) {
      warnedBadKey = true;
      console.error('[score] TypeSafe rejected the API key (401). Check TYPESAFE_API_KEY.');
    }
  } else if (err.status === 422) {
    // Only the error's own message: the body can quote the submitted text back.
    console.error(`[score] TypeSafe validation error (422) for reply ${id}:`, err.detail?.body?.error?.message || 'see TypeSafe dashboard');
  } else if (err.name === 'AbortError') {
    console.warn(`[score] TypeSafe call timed out for reply ${id}`);
  } else {
    console.warn(`[score] TypeSafe call failed for reply ${id}: ${err.status || err.message}`);
  }
}

// ---------- Handler ----------

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'POST only' });
  }

  const input = parseBody(req.body);
  if (!input) {
    return res.status(400).json({ error: 'Expected { post: string, replies: [{ id: string, text: string }] } with 1-20 replies' });
  }

  const limiter = await getLimiter();
  if (limiter) {
    const { success } = await limiter.limit(clientIp(req));
    if (!success) return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    console.error('[score] TYPESAFE_API_KEY is not set.');
    return res.status(200).json({ results: [], failed: input.replies.map((r) => r.id) });
  }

  const settled = await Promise.allSettled(input.replies.map((r) => scoreReply(key, input.post, r)));
  const results = [];
  const failed = [];
  settled.forEach((s, i) => {
    const { id } = input.replies[i];
    if (s.status === 'fulfilled') results.push(s.value);
    else {
      failed.push(id);
      logFailure(s.reason, id);
    }
  });

  return res.status(200).json({ results, failed });
}
