// Fake chrome.* for running content.js in a normal page (fixture ?standalone mode).
// The fake background answers "score" with a made-up Jev verdict after 700 ms, so the delayed collapse is visible.
(function () {
  const store = { settings: { enabled: true, strictness: 'medium', useJev: true }, stats: { allTime: 0 } };
  const listeners = [];
  const log = (window.__rgrShim = { scoreCalls: [], hiddenMsgs: 0 });

  function set(items, cb) {
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: store[k], newValue: v };
      store[k] = v;
    }
    setTimeout(() => listeners.forEach((fn) => fn(changes, 'local')));
    cb?.();
  }

  function get(keys, cb) {
    const out = {};
    for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
    setTimeout(() => cb(out));
  }

  // Stand-in for Jev: short replies look generic, longer ones look engaged.
  function fakeJev(text) {
    const words = text.trim().split(/\s+/).length;
    return words <= 8 ? { score: 1.55, confidence: 0.8 } : { score: 0.4, confidence: 0.85 };
  }

  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({}),
      sendMessage(msg, cb) {
        if (msg.type === 'score') {
          log.scoreCalls.push(msg.id);
          setTimeout(() => cb({ ...fakeJev(msg.text), source: 'jev' }), 700);
        } else if (msg.type === 'hidden') {
          log.hiddenMsgs++;
          store.stats = { allTime: store.stats.allTime + msg.n };
          setTimeout(() => cb({ allTime: store.stats.allTime }));
        }
      },
    },
    storage: {
      local: { get, set },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  window.__rgrSetSettings = (patch) => set({ settings: { ...store.settings, ...patch } });
})();
