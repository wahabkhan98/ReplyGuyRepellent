// Content script: finds replies on post detail pages, scores them, collapses low-effort ones, shows the counter.
(function () {
  const { SELECTORS: S, scoreKeywords, passesThreshold, KW_HIDE, KW_KEEP } = globalThis.RGR;

  const DETAIL_PATH = /^\/[^/]+\/status\/(\d+)/;
  const STATUS_ID = /\/status\/(\d+)/;
  const DEFAULT_SETTINGS = { enabled: true, strictness: 'medium', useJev: true };
  const SCAN_DEBOUNCE_MS = 150;
  const URL_POLL_MS = 500;
  const ANIM_MS = 200;
  const BAR_PX = 44;
  const SLAM_MS = 450; // stamp drop + bar thud
  const SLAM_STAGGER_MS = 80; // many collapses at once land as rapid-fire stamps
  const SLAM_MAX_WAIT_MS = 1500;

  const DEBUG = location.hostname === 'localhost' || safe(() => sessionStorage.getItem('rgrDebug') === '1');

  let settings = { ...DEFAULT_SETTINGS };
  let allTime = 0;
  let page = null; // { focalId, postText, ancestors } while on a post detail page
  let ready = false;

  // Everything is keyed by reply id, never by DOM node: X recycles article nodes while scrolling.
  const verdicts = new Map(); // id -> { score, confidence, source }
  const texts = new Map(); // id -> { text, post }
  const unsure = new Set(); // keyword scorer couldn't decide
  const pending = new Set(); // waiting on Jev
  const triedJev = new Set(); // Jev failed once; keep visible for the rest of the session
  const revealed = new Set(); // user clicked Show; never re-collapse
  const collapsedOnce = new Set(); // already animated once; re-renders collapse instantly
  const counted = new Set(); // already added to the all-time count

  function safe(fn) {
    try { return fn(); } catch { return undefined; }
  }

  function log(...args) {
    if (DEBUG) console.log('[RGR]', ...args);
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res ?? null);
        });
      } catch {
        resolve(null); // extension was reloaded; this page's script is orphaned
      }
    });
  }

  // ---------- Reading the page ----------

  // innerText drops X's emoji, which render as <img alt="🔥">.
  function textOf(el) {
    let out = '';
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) out += c.nodeValue;
        else if (c.nodeName === 'IMG') out += c.alt || '';
        else if (c.nodeName === 'BR') out += '\n';
        else if (c.nodeType === Node.ELEMENT_NODE) walk(c);
      }
    };
    walk(el);
    return out.trim();
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return 'h' + (h >>> 0).toString(16);
  }

  // The article's own permalink wraps its timestamp; other status links may belong to quotes.
  function idOf(article) {
    const time = article.querySelector(S.TIMESTAMP);
    const link = time?.closest(S.PERMALINK) || article.querySelector(S.PERMALINK);
    const m = link?.getAttribute('href')?.match(STATUS_ID);
    if (m) return m[1];
    const textEl = article.querySelector(S.TEXT);
    return textEl ? hash(textOf(textEl)) : null;
  }

  // ---------- Verdicts ----------

  function shouldHide(id) {
    if (!settings.enabled || revealed.has(id)) return false;
    const v = verdicts.get(id);
    if (!v) return false;
    if (v.source === 'jev' && !settings.useJev) return false;
    return passesThreshold(v, settings.strictness);
  }

  function classify(id, text, post) {
    texts.set(id, { text, post });
    const kw = scoreKeywords(text);
    if (kw === 'hide') verdicts.set(id, KW_HIDE);
    else if (kw === 'keep') verdicts.set(id, KW_KEEP);
    else {
      unsure.add(id);
      requestJev(id);
    }
  }

  function requestJev(id) {
    if (!settings.enabled || !settings.useJev) return;
    if (verdicts.has(id) || pending.has(id) || triedJev.has(id)) return;
    const { text, post } = texts.get(id);
    pending.add(id);
    send({ type: 'score', id, text, post }).then((res) => {
      pending.delete(id);
      if (res && typeof res.score === 'number' && typeof res.confidence === 'number') {
        verdicts.set(id, { score: res.score, confidence: res.confidence, source: 'jev' });
      } else {
        triedJev.add(id); // keyword fallback: unsure stays visible
      }
      renderAll();
    });
  }

  // ---------- Collapse UI ----------

  function collapse(article, id, animate) {
    const from = article.getBoundingClientRect().height;
    article.dataset.rgrState = 'collapsed';
    article.dataset.rgrTilt = String(tiltOf(id));
    if (animate && from > BAR_PX) {
      article.animate([{ maxHeight: `${from}px` }, { maxHeight: `${BAR_PX}px` }], { duration: ANIM_MS, easing: 'ease-out' });
    }
    stamp(article, id, animate);
  }

  function tiltOf(id) {
    let n = 0;
    for (const c of id) n += c.charCodeAt(0);
    return n % 4;
  }

  // Ink the stamp once the bar has closed. Collapses that arrive together are queued a beat apart.
  let nextSlamAt = 0;
  function stamp(article, id, animate) {
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      article.dataset.rgrInk = 'still';
      return;
    }
    const now = performance.now();
    const at = Math.min(Math.max(now + ANIM_MS * 0.6, nextSlamAt), now + SLAM_MAX_WAIT_MS);
    nextSlamAt = at + SLAM_STAGGER_MS;
    setTimeout(() => {
      if (article.dataset.rgrState !== 'collapsed' || article.dataset.rgrId !== id) return;
      article.dataset.rgrInk = 'slam';
      setTimeout(() => {
        if (article.dataset.rgrInk === 'slam') article.dataset.rgrInk = 'still';
      }, SLAM_MS);
    }, at - now);
  }

  function expand(article) {
    delete article.dataset.rgrState;
    delete article.dataset.rgrInk;
    const to = article.getBoundingClientRect().height;
    if (to > BAR_PX) {
      article.animate([{ maxHeight: `${BAR_PX}px`, overflow: 'hidden' }, { maxHeight: `${to}px`, overflow: 'hidden' }], { duration: ANIM_MS, easing: 'ease-out' });
    }
  }

  function render(article, id) {
    const hide = shouldHide(id);
    const collapsed = article.dataset.rgrState === 'collapsed';
    if (hide && !collapsed) {
      collapse(article, id, !collapsedOnce.has(id));
      collapsedOnce.add(id);
    } else if (!hide && collapsed) {
      expand(article);
    }
    if (revealed.has(id)) article.dataset.rgr = 'revealed';
    if (hide && !counted.has(id)) {
      counted.add(id);
      bumpAllTime();
    }
  }

  function renderAll() {
    for (const a of document.querySelectorAll(`${S.ARTICLE}[data-rgr-id]`)) render(a, a.dataset.rgrId);
    updateCounter();
  }

  function clear(article) {
    if (article.dataset.rgrState) delete article.dataset.rgrState;
    delete article.dataset.rgrInk;
    delete article.dataset.rgrTilt;
    delete article.dataset.rgr;
    delete article.dataset.rgrId;
  }

  function reveal(article) {
    const id = article.dataset.rgrId;
    if (!id) return;
    revealed.add(id);
    article.dataset.rgr = 'revealed';
    expand(article);
    updateCounter();
  }

  // Capture phase runs before X's own handlers, so a click on the bar reveals instead of opening the reply.
  function onBarActivate(e) {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    const article = e.target.closest?.(`${S.ARTICLE}[data-rgr-state="collapsed"]`);
    if (!article) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' || e.type === 'keydown') reveal(article);
  }

  function refreshTheme() {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!bg) return;
    const [r, g, b, alpha] = bg.map(Number);
    const transparent = alpha === 0;
    const lum = transparent ? 1 : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    document.documentElement.dataset.rgrTheme = lum < 0.5 ? 'dark' : 'light';
  }

  // ---------- Scanning ----------

  function scan() {
    if (!ready || !page) return;
    refreshTheme();
    const articles = [...document.querySelectorAll(S.ARTICLE)];
    const focal = articles.find((a) => idOf(a) === page.focalId) || null;
    if (focal && !page.postText) {
      const t = focal.querySelector(S.TEXT);
      page.postText = t ? textOf(t) : '';
    }

    for (const a of articles) {
      if (a === focal) { clear(a); continue; }
      const id = idOf(a);
      // Parent posts in a thread sit above the focal post; they are not replies.
      if (focal && a.compareDocumentPosition(focal) & Node.DOCUMENT_POSITION_FOLLOWING) page.ancestors.add(id);
      if (!id || page.ancestors.has(id) || a.closest(S.PROMOTED) || !a.querySelector(S.TIMESTAMP)) { clear(a); continue; }

      const textEl = a.querySelector(S.TEXT);
      if (!textEl) { clear(a); continue; } // image-only replies stay visible

      if (a.dataset.rgrId !== id) {
        clear(a); // recycled node now shows a different reply
        a.dataset.rgrId = id;
        a.dataset.rgr = 'seen';
      }
      if (!texts.has(id)) {
        const text = textOf(textEl);
        log('reply', id, text);
        classify(id, text, page.postText);
      }
      render(a, id);
    }
    updateCounter();
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  // Re-apply known verdicts to freshly rendered nodes immediately, so recycled replies don't flash open.
  function fastPath(mutations) {
    if (!ready || !page) return;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        const found = n.matches(S.ARTICLE) ? [n] : n.querySelectorAll(S.ARTICLE);
        for (const a of found) {
          const id = idOf(a);
          if (!id || !verdicts.has(id) || page.ancestors.has(id) || id === page.focalId) continue;
          if (a.dataset.rgrId !== id) { clear(a); a.dataset.rgrId = id; a.dataset.rgr = 'seen'; }
          render(a, id);
        }
      }
    }
  }

  function onUrlChange() {
    const m = location.pathname.match(DETAIL_PATH);
    if (m && m[1] === page?.focalId) return;
    page = m ? { focalId: m[1], postText: '', ancestors: new Set() } : null;
    if (!page) for (const a of document.querySelectorAll(`${S.ARTICLE}[data-rgr]`)) clear(a);
    scan();
    updateCounter();
  }

  // ---------- Counter ----------

  let counterEl = null;
  let counterMode = 'session';
  let shown = 0;
  let countAnim = null;

  function sessionCount() {
    let n = 0;
    for (const id of verdicts.keys()) if (shouldHide(id)) n++;
    return n;
  }

  function ensureCounter() {
    if (counterEl) return counterEl;
    counterEl = document.createElement('div');
    counterEl.id = 'rgr-counter';
    counterEl.setAttribute('role', 'button');
    counterEl.tabIndex = 0;
    counterEl.innerHTML =
      '<div class="rgr-main"><span class="rgr-broom">🧹</span> <span class="rgr-num">0</span> hidden</div>' +
      '<div class="rgr-sub"><span data-mode="session">this session</span> · <span data-mode="allTime">all-time</span></div>';
    const toggle = () => {
      counterMode = counterMode === 'session' ? 'allTime' : 'session';
      updateCounter();
    };
    counterEl.addEventListener('click', toggle);
    counterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    document.body.appendChild(counterEl);
    return counterEl;
  }

  function animateCount(el, target) {
    cancelAnimationFrame(countAnim);
    const start = shown;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 300);
      shown = Math.round(start + (target - start) * (1 - Math.pow(1 - p, 3)));
      el.textContent = shown.toLocaleString();
      if (p < 1) countAnim = requestAnimationFrame(step);
    };
    countAnim = requestAnimationFrame(step);
  }

  function updateCounter() {
    if (!ready || !document.body) return;
    const el = ensureCounter();
    el.hidden = !page || !settings.enabled;
    if (el.hidden) return;
    for (const s of el.querySelectorAll('[data-mode]')) s.classList.toggle('rgr-active', s.dataset.mode === counterMode);
    const target = counterMode === 'session' ? sessionCount() : allTime;
    if (target > shown) sweep(el.querySelector('.rgr-broom'));
    if (target !== shown) animateCount(el.querySelector('.rgr-num'), target);
  }

  function sweep(broom) {
    broom.classList.remove('rgr-sweep');
    void broom.offsetWidth; // restart the animation
    broom.classList.add('rgr-sweep');
  }

  function bumpAllTime() {
    allTime++;
    send({ type: 'hidden', n: 1 }).then((res) => {
      if (res && typeof res.allTime === 'number' && res.allTime > allTime) allTime = res.allTime;
      updateCounter();
    });
  }

  // ---------- Settings ----------

  function applySettings(next) {
    const prev = settings;
    settings = { ...DEFAULT_SETTINGS, ...next };
    if (settings.enabled && settings.useJev && (!prev.useJev || !prev.enabled)) {
      for (const id of unsure) requestJev(id);
    }
    renderAll();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) applySettings(changes.settings.newValue);
    if (changes.stats) {
      const n = changes.stats.newValue?.allTime ?? 0;
      if (n > allTime) allTime = n;
      updateCounter();
    }
  });

  // ---------- Boot ----------

  document.addEventListener('click', onBarActivate, true);
  document.addEventListener('keydown', onBarActivate, true);
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    document.addEventListener(type, onBarActivate, true);
  }

  new MutationObserver((mutations) => {
    fastPath(mutations);
    scheduleScan();
  }).observe(document.body, { childList: true, subtree: true });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onUrlChange();
    }
  }, URL_POLL_MS);

  chrome.storage.local.get(['settings', 'stats'], (data) => {
    settings = { ...DEFAULT_SETTINGS, ...(data?.settings || {}) };
    allTime = data?.stats?.allTime || 0;
    ready = true;
    onUrlChange();
  });
})();
