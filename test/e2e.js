// End-to-end check of content.js on the fixture, in headless Chrome over CDP. No dependencies.
//   node test/serve.js &   then   node test/e2e.js [--shots <dir>]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:8123/demo/status/1837000000000000000?standalone';
const PORT = 9333;
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > -1 ? process.argv[shotsIdx + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? '✔' : '✖'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rgr-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,2400', 'about:blank',
  ], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    await sleep(200);
    targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => null);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 1500, scale: 1 } });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  };

  // State of every article: what the fixture says it is vs. what the extension did.
  const STATE = `return [...document.querySelectorAll('article')].map((a) => ({
      kind: a.dataset.kind || (a.classList.contains('focal') ? 'focal' : 'parent'),
      id: a.dataset.rgrId || null,
      collapsed: a.dataset.rgrState === 'collapsed',
      rgr: a.dataset.rgr || null,
      ink: a.dataset.rgrInk || null,
      height: Math.round(a.getBoundingClientRect().height),
      text: a.querySelector('[data-testid="tweetText"]')?.textContent.slice(0, 40) || '',
    }));`;

  function verify(states, label, { revealed = new Set() } = {}) {
    const wrong = states.filter((s) => {
      if (revealed.has(s.id)) return s.collapsed;
      return (s.kind === 'bot') !== s.collapsed;
    });
    check(wrong.length === 0, `${label}: bot replies collapsed, real ones visible (${states.length} articles)`,
      wrong.map((s) => `${s.kind} ${s.collapsed ? 'COLLAPSED' : 'visible'}: "${s.text}"`).join('\n    '));
  }

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL });
  await sleep(2200); // keyword pass + 700 ms fake Jev + animations

  // ---------- M1: detection ----------
  let states = await js(STATE);
  const replyLogs = logs.filter((l) => l.startsWith('[RGR] reply'));
  const loggedIds = replyLogs.map((l) => l.split(' ')[2]);
  check(!loggedIds.includes('1837000000000000000') && !loggedIds.includes('1836999999999999999'), 'M1: original post and parent are never logged');
  check(new Set(loggedIds).size === loggedIds.length, 'M1: each reply logged exactly once', `${loggedIds.length} logs, ${new Set(loggedIds).size} unique`);
  const textReplies = states.filter((s) => s.kind === 'bot' || s.kind === 'real').length;
  check(loggedIds.length === textReplies, `M1: every text reply logged (${loggedIds.length}/${textReplies})`);
  check(states.filter((s) => ['ad', 'image', 'focal', 'parent'].includes(s.kind)).every((s) => !s.collapsed && !s.id),
    'M1: ad, image-only reply, focal post and parent are untouched');

  // ---------- M2: collapse ----------
  verify(states, 'M2 initial');
  check(states.filter((s) => s.collapsed).every((s) => s.height === 44), 'M2: collapsed bars are 44px',
    states.filter((s) => s.collapsed && s.height !== 44).map((s) => `${s.height}px "${s.text}"`).join(', '));
  check(states.filter((s) => s.collapsed).every((s) => s.ink === 'still'), 'Stamp: every collapsed reply is stamped and settled',
    states.filter((s) => s.collapsed && s.ink !== 'still').map((s) => `${s.ink} "${s.text}"`).join(', '));
  const jevAsked = await js('return window.__rgrShim.scoreCalls.length');
  check(jevAsked > 0 && jevAsked < textReplies / 2, `M5: only unsure replies go to Jev (${jevAsked} of ${textReplies})`);
  await shot('1-light-collapsed');

  // Click "Show" on the first collapsed reply, with real mouse events.
  const target = await js(`const a = document.querySelector('article[data-rgr-state="collapsed"]');
    a.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 100));
    const r = a.getBoundingClientRect(); return { id: a.dataset.rgrId, x: r.right - 30, y: r.top + 18 };`);
  const openedBefore = await js('return window.__opened || 0');
  await click(target.x, target.y);
  await sleep(400);
  const revealed = new Set([target.id]);
  states = await js(STATE);
  const t = states.find((s) => s.id === target.id);
  check(t && !t.collapsed && t.rgr === 'revealed', 'M2: clicking Show reveals the reply and marks it revealed');
  check((await js('return window.__opened || 0')) === openedBefore, "M2: the click doesn't reach X's own handler (no navigation)");

  // Rapid-fire: the 10 replies loaded below should ink one after another, not all at once.
  await js("window.__inkLog = []; new MutationObserver((ms) => ms.forEach((m) => m.target.dataset.rgrInk === 'slam' && window.__inkLog.push(performance.now()))).observe(document.body, { subtree: true, attributeFilter: ['data-rgr-ink'] })");

  // Fresh nodes for the same replies (scroll away and back).
  await js("document.getElementById('rerender').click()");
  await sleep(60); // well inside the 150 ms debounce: fast path must already have applied verdicts
  states = await js(STATE);
  verify(states, 'M2 re-render (before debounce, no flicker)', { revealed });
  check(!states.find((s) => s.id === target.id)?.collapsed, 'M2: revealed reply stays revealed after re-render');
  await sleep(400);

  // Same nodes, different replies inside.
  await js("document.getElementById('recycle').click()");
  await sleep(400);
  verify(await js(STATE), 'M2 recycled nodes', { revealed });

  // Infinite scroll.
  await js("document.getElementById('more').click()");
  await sleep(1600);
  states = await js(STATE);
  verify(states, 'M1/M2 after loading 10 more', { revealed });
  const inks = await js('return window.__inkLog');
  const gaps = inks.slice(1).map((t, i) => t - inks[i]);
  check(inks.length >= 5 && gaps.every((g) => g >= 60), `Stamp: new collapses slam in sequence (${inks.length} slams, min gap ${Math.round(Math.min(...gaps))}ms)`);
  check(states.filter((s) => s.collapsed).every((s) => s.ink === 'still'), 'Stamp: re-rendered and recycled nodes are stamped without re-slamming');
  const logs2 = logs.filter((l) => l.startsWith('[RGR] reply')).map((l) => l.split(' ')[2]);
  check(new Set(logs2).size === logs2.length && logs2.length === loggedIds.length + 10, `M1: new replies logged once each (${logs2.length} total)`);

  // ---------- M3: counter + settings ----------
  const counter = await js(`const c = document.getElementById('rgr-counter'); return { hidden: c.hidden, text: c.textContent };`);
  const expectHidden = states.filter((s) => s.kind === 'bot' && !revealed.has(s.id)).length;
  check(!counter.hidden && counter.text.includes(`${expectHidden} hidden`), `M3: counter shows "${expectHidden} hidden"`, counter.text);
  await js("document.body.className = 'dark'");
  await sleep(300);
  await js('window.scrollTo(0, 0)');
  await sleep(200);
  await shot('2-dark-collapsed');

  if (SHOTS) {
    for (const theme of ['dark', '']) {
      await js(`document.body.className = '${theme}'`);
      await sleep(250);
      const r = await js(`const a = document.querySelector('article[data-rgr-ink="still"]'); a.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 100)); const b = a.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height };`);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y - 8, width: r.w, height: r.h + 16, scale: 2 } });
      fs.writeFileSync(path.join(SHOTS, `3-closeup-${theme || 'light'}.png`), Buffer.from(data, 'base64'));
    }
    await js("document.body.className = 'dark'");
  }

  await js("document.getElementById('rgr-counter').click()");
  await sleep(400);
  const allTimeText = await js("return document.getElementById('rgr-counter').textContent");
  check(/all-time/.test(allTimeText) && !allTimeText.includes(' 0 hidden'), 'M3: tapping the counter switches to all-time', allTimeText);
  await js("document.getElementById('rgr-counter').click()");

  await js("window.__rgrSetSettings({ strictness: 'low' })");
  await sleep(400);
  states = await js(STATE);
  const jevHidden = states.filter((s) => s.collapsed && /resonates|powerful/.test(s.text));
  check(jevHidden.length === 0, 'M3: strictness Low re-applies instantly (Jev 1.55 no longer hides)');
  const callsBefore = await js('return window.__rgrShim.scoreCalls.length');
  await js("window.__rgrSetSettings({ strictness: 'medium' })");
  await sleep(400);
  check((await js('return window.__rgrShim.scoreCalls.length')) === callsBefore, 'M3: strictness change makes zero new Jev calls');

  await js('window.__rgrSetSettings({ enabled: false })');
  await sleep(400);
  states = await js(STATE);
  const counterOff = await js("return document.getElementById('rgr-counter').hidden");
  check(states.every((s) => !s.collapsed) && counterOff, 'M3: turning off reveals everything and hides the counter');
  await js('window.__rgrSetSettings({ enabled: true })');
  await sleep(400);
  verify(await js(STATE), 'M3 re-enabled', { revealed });

  await js('window.__rgrSetSettings({ useJev: false })');
  await sleep(400);
  states = await js(STATE);
  check(states.filter((s) => s.collapsed && /resonates|powerful/.test(s.text)).length === 0, 'M5: Jev off keeps unsure replies visible');

  const errors = logs.filter((l) => /error|uncaught/i.test(l));
  check(errors.length === 0, 'No console errors', errors.join('\n    '));

  ws.close();
  chrome.kill();
  await new Promise((r) => chrome.once('exit', r));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
