/**
 * background.js — MV3 service worker. Owns the harvest queue.
 *
 * Flow per query:
 *   page 1 -> https://www.bing.com/search?q=QUERY&first=1
 *   page 2 -> …&first=11, page 3 -> …&first=21, …
 *   inject content.js -> { links, noResults, captcha }
 *   clean + dedupe links -> persist -> wait 3 s -> next page
 * until a stop condition is hit, then move to the next query.
 *
 * Design notes
 * - One in-memory `state` object is the single source of truth. Every
 *   mutation is persisted to chrome.storage.local so a restarted service
 *   worker (or a reopened popup) can pick up exactly where it left off.
 * - The popup keeps a `chrome.runtime.connect` port open and pings it, which
 *   keeps this worker alive while a harvest is running.
 * - Exactly ONE Bing tab is ever used; it is reused for every page.
 * - Each run gets a `runId`. A loop exits as soon as the runId changes
 *   (Stop / Start again), so two loops can never drive the tab at once.
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  PAGE_DELAY_MS: 3000,        // pause between page loads (CAPTCHA avoidance)
  PAGE_LOAD_TIMEOUT_MS: 30000, // give up on a page after this long
  SETTLE_DELAY_MS: 800,       // extra wait after "complete" for late DOM work
  MAX_PAGES_PER_QUERY: 50,    // Bing rarely serves more than ~50 pages
  MAX_CONSECUTIVE_FAILURES: 3, // failed page loads in a row before skipping the query
  RESULTS_PER_PAGE: 10,       // Bing's `first` param steps by 10
  LOG_LIMIT: 60,              // activity-log lines kept in state
};

/**
 * Domains that are never stores. A URL is dropped when its hostname equals
 * one of these or is a subdomain of one (e.g. m.facebook.com).
 */
const BLOCKED_DOMAINS = [
  'bing.com', 'microsoft.com', 'msn.com', 'live.com',
  'facebook.com', 'instagram.com', 'youtube.com', 'youtu.be',
  'twitter.com', 'x.com', 'linkedin.com', 'pinterest.com',
  'pinterest.com.au', 'tiktok.com', 'reddit.com', 'quora.com',
  'wikipedia.org', 'google.com', 'apple.com', 'yelp.com',
  'yelp.com.au', 'tripadvisor.com', 'tripadvisor.com.au',
  'trustpilot.com', 'amazon.com', 'amazon.com.au', 'ebay.com',
  'ebay.com.au', 'etsy.com', 'gumtree.com.au',
];

const STORAGE_KEY = 'harvestState';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @returns a fresh, idle state object. */
function createInitialState() {
  return {
    status: 'idle',      // 'idle' | 'running' | 'paused' | 'done' | 'stopped'
    runId: 0,
    queries: [],
    queryIndex: 0,       // 0-based index into `queries`
    page: 1,             // 1-based Bing page number for the current query
    querySeen: [],       // raw URLs already seen for the CURRENT query (repeat detection)
    failures: 0,         // consecutive page-load failures for the current query
    links: [],           // final, cleaned, globally unique URLs
    tabId: null,
    message: 'Paste your queries and press Start Harvest.',
    log: [],
    startedAt: null,
    finishedAt: null,
  };
}

let state = createInitialState();

/** Resolves once state has been restored from storage. Await before using `state`. */
const ready = chrome.storage.local.get(STORAGE_KEY).then((stored) => {
  if (stored && stored[STORAGE_KEY]) {
    state = { ...createInitialState(), ...stored[STORAGE_KEY] };
  }
}).catch((err) => console.error('[Harvester] Failed to restore state:', err));

/** Persist state and push it to any open popup. */
async function commit() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch (err) {
    console.error('[Harvester] Failed to save state:', err);
  }
  broadcast({ type: 'state', state });
  updateBadge();
}

/** Append a line to the activity log (newest last, capped). */
function log(line) {
  console.log('[Harvester]', line);
  state.log.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (state.log.length > CONFIG.LOG_LIMIT) state.log.splice(0, state.log.length - CONFIG.LOG_LIMIT);
}

// ---------------------------------------------------------------------------
// Popup connection (keeps the worker alive while the popup is open)
// ---------------------------------------------------------------------------

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();

function broadcast(message) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch (err) {
      ports.delete(port); // popup already gone
    }
  }
}

chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== 'harvester') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => handlePopupMessage(msg).catch((err) => {
    console.error('[Harvester] Error handling popup message:', msg, err);
  }));

  await ready;
  port.postMessage({ type: 'state', state });

  // The worker may have been killed mid-run (e.g. popup closed for a while).
  // If storage says we were running but no loop is alive, resume now.
  if (state.status === 'running' && !loopAlive) {
    log('Resuming interrupted harvest.');
    startLoop();
  }
});

/** Routes commands sent by popup.js. */
async function handlePopupMessage(msg) {
  await ready;
  switch (msg && msg.type) {
    case 'ping':
      // No-op: receiving a message resets the service worker idle timer.
      return;
    case 'start':
      return startHarvest(msg.queries);
    case 'stop':
      return stopHarvest();
    case 'resume':
      return resumeHarvest();
    case 'clear':
      return clearResults();
    case 'showTab':
      return showHarvestTab();
    default:
      console.warn('[Harvester] Unknown popup message:', msg);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Start a brand-new harvest. Previously collected links are kept and merged into. */
async function startHarvest(rawQueries) {
  const queries = (rawQueries || [])
    .map((q) => String(q).trim())
    .filter(Boolean);

  if (queries.length === 0) {
    state.message = 'Add at least one query (one per line).';
    return commit();
  }

  Object.assign(state, {
    status: 'running',
    runId: state.runId + 1,
    queries,
    queryIndex: 0,
    page: 1,
    querySeen: [],
    failures: 0,
    message: 'Starting…',
    startedAt: Date.now(),
    finishedAt: null,
  });
  log(`Started harvest with ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}.`);
  await commit();
  startLoop();
}

/** Stop the current run. Collected links are kept. */
async function stopHarvest() {
  if (state.status !== 'running' && state.status !== 'paused') return;
  state.status = 'stopped';
  state.runId += 1; // invalidates the running loop
  state.message = `Stopped. ${state.links.length} unique links collected.`;
  state.finishedAt = Date.now();
  log('Stopped by user.');
  await commit();
  await closeHarvestTab();
}

/** Continue after a CAPTCHA pause — re-tries the same page. */
async function resumeHarvest() {
  if (state.status !== 'paused') return;
  state.status = 'running';
  state.runId += 1;
  state.message = 'Resuming…';
  log('Resumed by user.');
  await commit();
  startLoop();
}

/** Wipe results and return to idle. Not allowed mid-run. */
async function clearResults() {
  if (state.status === 'running') return;
  await closeHarvestTab();
  const queries = state.queries; // keep the textarea content handy
  state = { ...createInitialState(), runId: state.runId + 1, queries };
  await commit();
}

/** Bring the Bing tab to the front (used to solve a CAPTCHA). */
async function showHarvestTab() {
  if (state.tabId == null) return;
  try {
    const tab = await chrome.tabs.update(state.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    console.error('[Harvester] Could not focus the Bing tab:', err);
  }
}

// ---------------------------------------------------------------------------
// The harvest loop
// ---------------------------------------------------------------------------

let loopAlive = false;

/** Fire-and-forget wrapper so callers never await the whole harvest. */
function startLoop() {
  runLoop(state.runId).catch(async (err) => {
    console.error('[Harvester] Fatal loop error:', err);
    state.status = 'stopped';
    state.message = `Error: ${err.message}. ${state.links.length} links kept.`;
    await commit();
  });
}

/**
 * Processes pages until the queue is exhausted, the user stops, or a CAPTCHA
 * appears. Re-checks `isCurrent()` after every await so a stale loop never
 * touches state after Stop/Start.
 */
async function runLoop(myRunId) {
  const isCurrent = () => state.runId === myRunId && state.status === 'running';

  loopAlive = true;
  try {
    while (isCurrent()) {
      // ---- Queue exhausted? -------------------------------------------------
      if (state.queryIndex >= state.queries.length) {
        await finishHarvest();
        return;
      }

      const query = state.queries[state.queryIndex];
      const page = state.page;
      const url = buildSearchUrl(query, page);

      state.message = progressMessage('Loading');
      await commit();

      // ---- Load + extract ---------------------------------------------------
      let result = null;
      try {
        const tabId = await ensureHarvestTab();
        if (!isCurrent()) return;
        await navigateAndWait(tabId, url);
        if (!isCurrent()) return;
        await sleep(CONFIG.SETTLE_DELAY_MS);
        if (!isCurrent()) return;
        result = await extractFromTab(tabId);
      } catch (err) {
        console.error(`[Harvester] Page failed (query ${state.queryIndex + 1}, page ${page}):`, url, err);
      }
      if (!isCurrent()) return;

      // ---- Page failed to load: skip it and continue ------------------------
      if (!result) {
        state.failures += 1;
        if (state.failures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
          log(`Q${state.queryIndex + 1} p${page}: failed ${state.failures}× in a row — skipping query.`);
          advanceToNextQuery();
        } else {
          log(`Q${state.queryIndex + 1} p${page}: failed to load — skipping page.`);
          state.page += 1;
        }
        await commit();
        await sleep(CONFIG.PAGE_DELAY_MS);
        continue;
      }
      state.failures = 0;

      // ---- CAPTCHA: pause and alert -----------------------------------------
      if (result.captcha) {
        state.status = 'paused';
        state.message =
          `CAPTCHA detected on query ${state.queryIndex + 1}, page ${page}. ` +
          'Solve it in the Bing tab, then press Resume.';
        log(`Q${state.queryIndex + 1} p${page}: CAPTCHA — paused.`);
        await commit();
        broadcast({ type: 'captcha', message: state.message });
        return; // tab stays open so the user can solve it
      }

      // ---- Merge links -------------------------------------------------------
      const { newForQuery, added } = mergeLinks(result.links);
      log(
        `Q${state.queryIndex + 1} p${page}: ${result.links.length} results, ` +
        `${added} new stored (${state.links.length} total).`
      );

      // ---- Decide whether this query is finished ----------------------------
      const stopReason =
        result.noResults ? 'no results'
        : result.links.length === 0 ? 'empty page'
        : newForQuery === 0 ? 'no new links (repeating)'
        : page >= CONFIG.MAX_PAGES_PER_QUERY ? `page limit (${CONFIG.MAX_PAGES_PER_QUERY})`
        : null;

      if (stopReason) {
        log(`Q${state.queryIndex + 1} done: ${stopReason}.`);
        advanceToNextQuery();
      } else {
        state.page += 1;
      }

      state.message = progressMessage('Waiting');
      await commit();

      // ---- Throttle before the next request ----------------------------------
      if (state.queryIndex < state.queries.length) await sleep(CONFIG.PAGE_DELAY_MS);
    }
  } finally {
    if (state.runId === myRunId) loopAlive = false;
  }
}

/** Mark the run complete and close the Bing tab. */
async function finishHarvest() {
  state.status = 'done';
  state.finishedAt = Date.now();
  state.message = `Done — ${state.links.length} unique links from ${state.queries.length} quer${state.queries.length === 1 ? 'y' : 'ies'}.`;
  log('Harvest complete.');
  await commit();
  await closeHarvestTab();
}

/** Reset per-query counters and move the cursor to the next query. */
function advanceToNextQuery() {
  state.queryIndex += 1;
  state.page = 1;
  state.querySeen = [];
  state.failures = 0;
}

/** e.g. "Query 1/5 — Page 3 — Found 12 links…" */
function progressMessage(verb) {
  const q = Math.min(state.queryIndex + 1, state.queries.length);
  return `${verb}: Query ${q}/${state.queries.length} — Page ${state.page} — Found ${state.links.length} links…`;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Page 1 -> first=1, page 2 -> first=11, page 3 -> first=21 … */
function buildSearchUrl(query, page) {
  const first = (page - 1) * CONFIG.RESULTS_PER_PAGE + 1;
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}`;
}

/**
 * Normalise a URL for storage: http(s) only, no #fragment.
 * @returns {string|null} cleaned URL, or null if invalid/blocked.
 */
function cleanUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (isBlockedHost(url.hostname)) return null;
  url.hash = '';
  return url.href;
}

/** True if `hostname` is (a subdomain of) any BLOCKED_DOMAINS entry. */
function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Merge one page's raw links into state.
 * - `newForQuery`: raw links not seen earlier for this query. When this hits 0,
 *   Bing is just repeating its last page, so the query is finished.
 * - `added`: cleaned links that were new to the global result list.
 */
function mergeLinks(rawLinks) {
  const seenForQuery = new Set(state.querySeen);
  const global = new Set(state.links);
  let newForQuery = 0;
  let added = 0;

  for (const raw of rawLinks) {
    if (!seenForQuery.has(raw)) {
      seenForQuery.add(raw);
      newForQuery += 1;
    }
    const clean = cleanUrl(raw);
    if (clean && !global.has(clean)) {
      global.add(clean);
      state.links.push(clean);
      added += 1;
    }
  }

  state.querySeen = Array.from(seenForQuery);
  return { newForQuery, added };
}

// ---------------------------------------------------------------------------
// Tab helpers (exactly one harvest tab, reused for every page)
// ---------------------------------------------------------------------------

/** Return the existing harvest tab, or open a new background tab. */
async function ensureHarvestTab() {
  if (state.tabId != null) {
    try {
      await chrome.tabs.get(state.tabId);
      return state.tabId;
    } catch {
      state.tabId = null; // user closed it — make a new one
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  state.tabId = tab.id;
  await commit();
  return tab.id;
}

async function closeHarvestTab() {
  if (state.tabId == null) return;
  const tabId = state.tabId;
  state.tabId = null;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* already closed */
  }
  await commit();
}

// Forget the tab if the user closes it manually.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (tabId === state.tabId) {
    state.tabId = null;
    await commit();
  }
});

/**
 * Navigate `tabId` to `url` and resolve when it finishes loading.
 * Rejects on timeout or if the tab is closed.
 */
function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const onUpdated = (id, info, tab) => {
      if (id !== tabId || info.status !== 'complete') return;
      if (!tab.url || tab.url === 'about:blank') return; // ignore the blank placeholder
      cleanup();
      resolve(tab);
    };
    const onRemoved = (id) => {
      if (id !== tabId) return;
      cleanup();
      reject(new Error('Harvest tab was closed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${CONFIG.PAGE_LOAD_TIMEOUT_MS} ms`));
    }, CONFIG.PAGE_LOAD_TIMEOUT_MS);

    // Attach listeners BEFORE navigating so we can't miss the "complete" event.
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.update(tabId, { url }).catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

/** Inject content.js and return its result object. */
async function extractFromTab(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  const result = injection && injection.result;
  if (!result || !Array.isArray(result.links)) {
    throw new Error('content.js returned no data');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Toolbar badge: link count while running, "!" when paused for CAPTCHA. */
function updateBadge() {
  let text = '';
  let color = '#2563eb';
  if (state.status === 'paused') {
    text = '!';
    color = '#dc2626';
  } else if (state.status === 'running') {
    text = state.links.length > 999 ? '999+' : String(state.links.length);
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

ready.then(updateBadge);
