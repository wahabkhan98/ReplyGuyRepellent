const test = require('node:test');
const assert = require('node:assert/strict');

// Import ES module handler
async function getHandler() {
  const mod = await import('../proxy/api/score.js');
  return mod.default;
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    body: null,
    setHeader(key, val) {
      this.headers[key.toLowerCase()] = val;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

test('OPTIONS preflight returns 204 with CORS for chrome-extension origin', async () => {
  const handler = await getHandler();
  const req = {
    method: 'OPTIONS',
    headers: { origin: 'chrome-extension://abcdefghijklmnop' },
  };
  const res = mockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop');
  assert.equal(res.ended, true);
});

test('non-POST returns 405 Method Not Allowed', async () => {
  const handler = await getHandler();
  const req = {
    method: 'GET',
    headers: {},
  };
  const res = mockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, 'POST only');
});

test('malformed or missing body returns 400', async () => {
  const handler = await getHandler();
  const res1 = mockRes();
  await handler({ method: 'POST', headers: {}, body: {} }, res1);
  assert.equal(res1.statusCode, 400);

  const res2 = mockRes();
  await handler({ method: 'POST', headers: {}, body: { post: 'hello', replies: [] } }, res2);
  assert.equal(res2.statusCode, 400);

  const res3 = mockRes();
  await handler({ method: 'POST', headers: {}, body: 'invalid-json' }, res3);
  assert.equal(res3.statusCode, 400);
});

test('missing TYPESAFE_API_KEY safely returns empty results and marks all replies as failed', async () => {
  const handler = await getHandler();
  const oldKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;

  const req = {
    method: 'POST',
    headers: { origin: 'chrome-extension://myextensionid' },
    body: {
      post: 'Building an extension',
      replies: [
        { id: '1', text: 'Great insight!' },
        { id: '2', text: 'How did you handle the database?' },
      ],
    },
  };
  const res = mockRes();
  await handler(req, res);

  if (oldKey) process.env.TYPESAFE_API_KEY = oldKey;

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.results, []);
  assert.deepEqual(res.body.failed, ['1', '2']);
});
