// Service worker: batches "unsure" replies to the proxy, owns the verdict cache and the all-time counter.

// Paste your deployed proxy URL here (and in manifest.json host_permissions).
const PROXY_URL = 'https://REPLACE-ME.vercel.app/api/score';


const FLUSH_MS = 400;
const BATCH_MAX = 20;
const MAX_IN_FLIGHT = 3;
const REQUEST_TIMEOUT_MS = 12000; // proxy may spend ~9 s on a 429 retry
const CACHE_MAX = 5000;
const PERSIST_DEBOUNCE_MS = 1000;
const TEXT_MAX = 1000;
const DEFAULT_SETTINGS = { enabled: true, strictness: 'medium', useJev: true };

const proxyConfigured = !PROXY_URL.includes('REPLACE-ME');

// ---------- Logging (once per worker lifetime, never in the page) ----------

const logged = new Set();
function logOnce(key, ...args) {
  if (logged.has(key)) return;
  logged.add(key);
  console.warn('[RGR]', ...args);
}

// ---------- Settings ----------

chrome.runtime.onInstalled.addListener(async () => {
  const { settings, stats } = await chrome.storage.local.get(['settings', 'stats']);
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    stats: { allTime: 0, ...(stats || {}) },
  });
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---------- Verdict cache: { [replyId]: { score, confidence, source, t } } ----------

let cache = null;
let cacheLoad = null;
let cacheTimer = null;

function loadCache() {
  cacheLoad ||= chrome.storage.local.get('cache').then(({ cache: c }) => {
    cache = c || {};
  });
  return cacheLoad;
}

function persistCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    const ids = Object.keys(cache);
    if (ids.length > CACHE_MAX) {
      ids.sort((a, b) => cache[a].t - cache[b].t);
      for (const id of ids.slice(0, ids.length - CACHE_MAX)) delete cache[id];
    }
    chrome.storage.local.set({ cache });
  }, PERSIST_DEBOUNCE_MS);
}

// ---------- All-time counter, one write per second at most ----------

let allTime = null;
let statsLoad = null;
let statsTimer = null;

async function bumpStats(n) {
  statsLoad ||= chrome.storage.local.get('stats').then(({ stats }) => {
    allTime = stats?.allTime || 0;
  });
  await statsLoad;
  allTime += n;
  if (!statsTimer) {
    statsTimer = setTimeout(() => {
      statsTimer = null;
      chrome.storage.local.set({ stats: { allTime } });
    }, PERSIST_DEBOUNCE_MS);
  }
  return allTime;
}

// ---------- Queue: flush every 400 ms or at 20 replies, max 3 requests in flight ----------

const queues = new Map(); // post text -> [{ id, text }]
const waiters = new Map(); // reply id -> [resolve]
let inFlight = 0;
let flushTimer = null;

function settle(id, verdict) {
  for (const resolve of waiters.get(id) || []) resolve(verdict);
  waiters.delete(id);
}

function enqueue(post, item) {
  if (!queues.has(post)) queues.set(post, []);
  const q = queues.get(post);
  q.push(item);
  if (q.length >= BATCH_MAX) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  for (const [post, q] of queues) {
    while (q.length && inFlight < MAX_IN_FLIGHT) send(post, q.splice(0, BATCH_MAX));
    if (!q.length) queues.delete(post);
  }
  // Anything left waits for an in-flight request to finish.
}

async function send(post, batch) {
  inFlight++;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const settled = new Set();
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post: post.slice(0, TEXT_MAX), replies: batch }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`proxy returned ${res.status}`);
    const { results = [], failed = [] } = await res.json();
    if (failed.length) logOnce('failed', `Smart scoring failed for ${failed.length} replies; using keywords for those.`);
    await loadCache();
    const t = Date.now();
    for (const r of results) {
      if (typeof r?.score !== 'number' || typeof r?.confidence !== 'number') continue;
      const verdict = { score: r.score, confidence: r.confidence, source: 'jev' };
      cache[r.id] = { ...verdict, t };
      settle(r.id, verdict);
      settled.add(r.id);
    }
    persistCache();
  } catch (err) {
    logOnce('proxy', 'Smart scoring unavailable, falling back to keywords:', err.message);
  } finally {
    clearTimeout(timeout);
    for (const { id } of batch) if (!settled.has(id)) settle(id, null);
    inFlight--;
    if (queues.size) flush();
  }
}

async function score({ id, text, post }) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.useJev) return null;
  await loadCache();
  const hit = cache[id];
  if (hit) return { score: hit.score, confidence: hit.confidence, source: 'jev' };
  if (!proxyConfigured) {
    logOnce('config', 'Proxy URL not set in background.js; smart scoring is off, keywords only.');
    return null;
  }
  return new Promise((resolve) => {
    if (waiters.has(id)) {
      waiters.get(id).push(resolve);
      return;
    }
    waiters.set(id, [resolve]);
    enqueue(String(post || ''), { id: String(id), text: String(text || '').slice(0, TEXT_MAX) });
  });
}

// ---------- Messages from content.js ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'score') {
    score(msg).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg?.type === 'hidden') {
    bumpStats(Number(msg.n) || 0).then((n) => sendResponse({ allTime: n }), () => sendResponse(null));
    return true;
  }
  return false;
});
