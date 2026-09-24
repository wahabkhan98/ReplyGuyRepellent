const DEFAULT_SETTINGS = { enabled: true, strictness: 'medium', useJev: true };

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };

function render() {
  $('enabled').checked = settings.enabled;
  $('useJev').checked = settings.useJev;
  document.body.classList.toggle('off', !settings.enabled);
  for (const b of $('strictness').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === settings.strictness));
  }
}

function renderCount(n) {
  $('allTime').textContent = (n || 0).toLocaleString();
}

function save(patch) {
  settings = { ...settings, ...patch };
  render();
  chrome.storage.local.set({ settings });
}

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('useJev').addEventListener('change', (e) => save({ useJev: e.target.checked }));
$('strictness').addEventListener('click', (e) => {
  const value = e.target.closest('button')?.dataset.value;
  if (value) save({ strictness: value });
});

chrome.storage.local.get(['settings', 'stats'], ({ settings: s, stats }) => {
  settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
  render();
  renderCount(stats?.allTime);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.stats) renderCount(changes.stats.newValue?.allTime);
});
