/**
 * popup.js — UI only. All harvesting happens in background.js.
 *
 * The popup:
 *  1. opens a long-lived port to the service worker (keeps it alive),
 *  2. sends commands (start / stop / resume / clear / showTab),
 *  3. re-renders whenever the worker broadcasts a new state,
 *  4. handles Copy and CSV export locally.
 */

'use strict';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const el = {
  queries: $('queries'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  resumeBtn: $('resumeBtn'),
  showTabBtn: $('showTabBtn'),
  status: $('status'),
  statusPill: $('statusPill'),
  progressBar: $('progressBar'),
  log: $('log'),
  results: $('results'),
  count: $('count'),
  copyBtn: $('copyBtn'),
  csvBtn: $('csvBtn'),
  clearBtn: $('clearBtn'),
  fullBtn: $('fullBtn'),
  optEnforceSite: $('optEnforceSite'),
  optSkipRewritten: $('optSkipRewritten'),
  optMarket: $('optMarket'),
  optDelay: $('optDelay'),
};
const OPTION_INPUTS = [el.optEnforceSite, el.optSkipRewritten, el.optMarket, el.optDelay];

// Full-page mode: popup.html?full=1 opened in a normal tab. Same code, wider
// layout, and it doesn't close when you click away or switch tabs.
const IS_FULL_PAGE = new URLSearchParams(location.search).has('full');
if (IS_FULL_PAGE) {
  document.body.classList.add('full');
  document.querySelector('details:not(#optionsBox)').open = true; // show the activity log
}

/** Latest state received from the background worker. */
let currentState = null;

// ---------------------------------------------------------------------------
// Connection to the service worker
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 20000; // < 30 s MV3 idle timeout

const port = chrome.runtime.connect({ name: 'harvester' });

port.onMessage.addListener((msg) => {
  if (msg.type === 'state') {
    render(msg.state);
  } else if (msg.type === 'captcha') {
    // No blocking alert(): the Bing tab is brought to the front, the status box
    // turns yellow, and a short chime plays. Harvesting resumes by itself once
    // the CAPTCHA is solved.
    chime();
  }
});

port.onDisconnect.addListener(() => {
  console.error('[Harvester popup] Lost connection to background:', chrome.runtime.lastError);
});

// Regular pings reset the worker's idle timer so it isn't killed mid-harvest.
setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);

function send(message) {
  try {
    port.postMessage(message);
  } catch (err) {
    console.error('[Harvester popup] Failed to send message:', message, err);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(state) {
  currentState = state;
  const { status } = state;
  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const isBusy = isRunning || isPaused;

  // Restore queries into an empty textarea (e.g. when the popup is reopened).
  if (!el.queries.value && state.queries.length) {
    el.queries.value = state.queries.join('\n');
  }
  el.queries.disabled = isBusy;

  // Options: mirror saved settings (but never overwrite while the user is editing).
  const settings = state.settings || {};
  if (!optionsTouched) {
    el.optEnforceSite.checked = settings.enforceSite !== false;
    el.optSkipRewritten.checked = settings.skipRewritten !== false;
    el.optMarket.value = settings.market || 'auto';
    el.optDelay.value = settings.delaySec || 5;
  }
  for (const input of OPTION_INPUTS) input.disabled = isBusy;

  // Status pill + message.
  el.statusPill.textContent = status;
  el.statusPill.dataset.status = status;
  el.status.textContent = state.message;
  el.status.classList.toggle('warn', isPaused);

  // Progress = finished queries / total (page counts are open-ended, so per-query only).
  const total = state.queries.length || 1;
  const done = status === 'done' ? total : Math.min(state.queryIndex, total);
  el.progressBar.style.width = `${Math.round((done / total) * 100)}%`;

  // Activity log, newest at the bottom, auto-scrolled.
  el.log.textContent = state.log.join('\n');
  el.log.scrollTop = el.log.scrollHeight;

  // Buttons.
  el.startBtn.hidden = isBusy;
  el.stopBtn.hidden = !isBusy;
  el.resumeBtn.hidden = !isPaused;
  el.showTabBtn.hidden = !(isBusy && state.tabId != null);

  // Results — only rewrite the textarea when the content changed, so a user's
  // selection/scroll isn't reset on every broadcast.
  const text = state.links.join('\n');
  if (el.results.value !== text) {
    const atBottom = el.results.scrollTop + el.results.clientHeight >= el.results.scrollHeight - 4;
    el.results.value = text;
    if (atBottom) el.results.scrollTop = el.results.scrollHeight;
  }
  const n = state.links.length;
  el.count.textContent = `${n} link${n === 1 ? '' : 's'}`;
  el.copyBtn.disabled = n === 0;
  el.csvBtn.disabled = n === 0;
  el.clearBtn.disabled = n === 0 || isRunning;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

el.startBtn.addEventListener('click', () => {
  const queries = el.queries.value.split(/\r?\n/).map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) {
    el.status.textContent = 'Add at least one query (one per line).';
    el.queries.focus();
    return;
  }
  send({ type: 'start', queries, settings: readSettings() });
});

/** True once the user changes an option, so incoming state doesn't undo it. */
let optionsTouched = false;
for (const input of OPTION_INPUTS) {
  input.addEventListener('change', () => { optionsTouched = true; });
}

/** Current option values from the form. */
function readSettings() {
  return {
    enforceSite: el.optEnforceSite.checked,
    skipRewritten: el.optSkipRewritten.checked,
    market: el.optMarket.value,
    delaySec: Math.min(60, Math.max(2, Number(el.optDelay.value) || 5)),
  };
}

// Open the same UI in a full tab (reuse it if one is already open), then close the popup.
el.fullBtn.addEventListener('click', async () => {
  const url = chrome.runtime.getURL('popup.html?full=1');
  try {
    const [existing] = await chrome.tabs.query({ url });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch (err) {
    console.error('[Harvester popup] Could not open full page:', err);
  }
  window.close();
});

el.stopBtn.addEventListener('click', () => send({ type: 'stop' }));
el.resumeBtn.addEventListener('click', () => send({ type: 'resume' }));

// Note: in the toolbar popup, focusing the Bing tab closes the popup. That's
// fine — once the CAPTCHA is solved the harvest resumes by itself, and all
// state is persisted. The full-page tab stays open, so just switch back to it.
el.showTabBtn.addEventListener('click', () => send({ type: 'showTab' }));

el.clearBtn.addEventListener('click', () => {
  if (confirm('Clear all collected links?')) send({ type: 'clear' });
});

el.copyBtn.addEventListener('click', async () => {
  const text = currentState ? currentState.links.join('\n') : '';
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Fallback for when the async clipboard API is unavailable.
    console.warn('[Harvester popup] Clipboard API failed, using fallback:', err);
    el.results.select();
    document.execCommand('copy');
  }
  flashButton(el.copyBtn, 'Copied!');
});

el.csvBtn.addEventListener('click', () => {
  if (!currentState || currentState.links.length === 0) return;
  const csv = toCsv(currentState.links);
  const date = new Date().toISOString().slice(0, 10);
  downloadText(csv, `bing-links-${date}.csv`, 'text/csv;charset=utf-8');
  flashButton(el.csvBtn, 'Exported!');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One-column CSV with a `url` header. Values are quoted per RFC 4180. */
function toCsv(urls) {
  const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return ['url', ...urls.map(escape)].join('\r\n') + '\r\n';
}

/** Trigger a file download from the popup without the "downloads" permission. */
function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Two short beeps to get attention when a CAPTCHA appears. Silently skipped if audio is blocked. */
function chime() {
  try {
    const ctx = new AudioContext();
    [0, 0.25].forEach((t) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.2);
    });
    setTimeout(() => ctx.close(), 800);
  } catch (err) {
    console.warn('[Harvester popup] Could not play chime:', err);
  }
}

/** Briefly swap a button's label as feedback. */
function flashButton(button, label) {
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => { button.textContent = original; }, 1200);
}
