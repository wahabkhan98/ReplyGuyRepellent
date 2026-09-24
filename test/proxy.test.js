// Runs the Vercel handler locally against a mocked TypeSafe API. No key or network needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const realFetch = globalThis.fetch;
let handler;

test.before(async () => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  ({ default: handler } = await import(path.join(__dirname, '../proxy/api/score.js')));
});
test.after(() => { globalThis.fetch = realFetch; });

function call(body, { method = 'POST', origin } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload, headers }); },
      end() { resolve({ status: this.statusCode, body: null, headers }); },
    };
    handler({ method, body, headers: origin ? { origin } : {}, socket: {} }, res);
  });
}

function mockTypeSafe(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push({ url, init, req });
    const { status = 200, body = {}, headers = {} } = await respond(req, calls.length);
    return new Response(JSON.stringify(body), { status, headers });
  };
  return calls;
}

const replies = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, text: `reply ${i}` }));
const ok = (score, confidence) => ({ body: { model: 'jev-1.13.0', answers: { lowEffort: { type: 'score', score, confidence } } } });

test('scores 5 replies in parallel with the documented request shape', async () => {
  const calls = mockTypeSafe(() => ok(1.8, 0.84));
  const out = await call({ post: 'Original post', replies: replies(5) });
  assert.equal(out.status, 200);
  assert.equal(out.body.results.length, 5);
  assert.deepEqual(out.body.failed, []);
  for (const r of out.body.results) {
    assert.ok(r.score >= 0 && r.score <= 2);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
  assert.equal(calls.length, 5);
  const { url, init, req } = calls[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.headers.Authorization, 'Bearer test-key');
  assert.equal(req.model, 'jev-latest');
  assert.deepEqual(req.state, { post: 'Original post', reply: 'reply 0' });
  assert.equal(req.questions.lowEffort.type, 'score');
  assert.equal(req.questions.lowEffort.criteria.length, 3);
});

test('rejects malformed bodies with 400', async () => {
  mockTypeSafe(() => ok(1, 1));
  for (const body of [null, {}, { post: 'x' }, { post: 'x', replies: [] }, { post: 'x', replies: replies(21) },
    { post: 1, replies: replies(1) }, { post: 'x', replies: [{ id: 1, text: 'a' }] }, '{not json']) {
    const out = await call(body);
    assert.equal(out.status, 400, JSON.stringify(body));
  }
});

test('rejects non-POST and answers preflight for extension origins only', async () => {
  assert.equal((await call(null, { method: 'GET' })).status, 405);
  const pre = await call(null, { method: 'OPTIONS', origin: 'chrome-extension://abc' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'chrome-extension://abc');
  const web = await call(null, { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(web.headers['access-control-allow-origin'], undefined);
});

test('bad key puts every reply in failed instead of crashing', async () => {
  mockTypeSafe(() => ({ status: 401, body: { error: 'Missing or invalid API key' } }));
  const out = await call({ post: 'p', replies: replies(5) });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.results, []);
  assert.deepEqual(out.body.failed, ['r0', 'r1', 'r2', 'r3', 'r4']);
});

test('422 and 529 fail only the affected reply', async () => {
  mockTypeSafe((req) => {
    if (req.state.reply === 'reply 1') return { status: 422, body: { error: 'bad field' } };
    if (req.state.reply === 'reply 2') return { status: 529, body: {} };
    return ok(0.3, 0.9);
  });
  const out = await call({ post: 'p', replies: replies(4) });
  assert.deepEqual(out.body.failed.sort(), ['r1', 'r2']);
  assert.equal(out.body.results.length, 2);
});

test('429 waits retry_after and retries once', async () => {
  const seen = {};
  mockTypeSafe((req) => {
    const n = (seen[req.state.reply] = (seen[req.state.reply] || 0) + 1);
    if (req.state.reply === 'reply 0' && n === 1) return { status: 429, body: { retry_after: 0.05 } };
    if (req.state.reply === 'reply 1') return { status: 429, body: { retry_after: 0.05 } };
    return ok(1.2, 0.7);
  });
  const out = await call({ post: 'p', replies: replies(2) });
  assert.deepEqual(out.body.results.map((r) => r.id), ['r0']);
  assert.deepEqual(out.body.failed, ['r1']);
  assert.equal(seen['reply 1'], 2);
});

test('a hung TypeSafe call is aborted after 3 s and counted as failed', { timeout: 6000 }, async () => {
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const t0 = Date.now();
  const out = await call({ post: 'p', replies: replies(1) });
  assert.deepEqual(out.body.failed, ['r0']);
  assert.ok(Date.now() - t0 >= 2900);
});

test('truncates post and reply text to 1,000 characters', async () => {
  const calls = mockTypeSafe(() => ok(1, 1));
  await call({ post: 'p'.repeat(5000), replies: [{ id: 'a', text: 'r'.repeat(5000) }] });
  assert.equal(calls[0].req.state.post.length, 1000);
  assert.equal(calls[0].req.state.reply.length, 1000);
});
