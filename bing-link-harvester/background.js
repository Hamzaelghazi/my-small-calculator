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
  MAX_OFF_TARGET_PAGES: 2,    // pages in a row with only off-target results before skipping the query
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

/**
 * User options (set in the popup, saved with the state).
 * - enforceSite:   drop results that don't match the query's site: / -site:
 *                  operators. Bing often ignores operators on automated
 *                  searches, so this check is done again here.
 * - skipRewritten: if Bing changes the query ("Including results for …",
 *                  "Did you mean …", or a different query in its search box),
 *                  collect nothing for that query and move on.
 * - market:        'auto' = use loc:XX from the query as Bing's country (cc=XX);
 *                  'none' = add nothing; otherwise a market code like 'en-AU'.
 */
const DEFAULT_SETTINGS = {
  enforceSite: true,
  skipRewritten: true,
  market: 'auto',
};

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
    offTargetPages: 0,   // consecutive pages where every result failed the site: check
    links: [],           // final, cleaned, globally unique URLs
    settings: { ...DEFAULT_SETTINGS },
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
    state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
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
      return startHarvest(msg.queries, msg.settings);
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
async function startHarvest(rawQueries, settings) {
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
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    queryIndex: 0,
    page: 1,
    querySeen: [],
    failures: 0,
    offTargetPages: 0,
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
  const { queries, settings } = state; // keep the textarea content and options
  state = { ...createInitialState(), runId: state.runId + 1, queries, settings };
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
      const url = buildSearchUrl(query, page, state.settings);

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

      // ---- Bing changed the query: its results are off-target -------------
      const changedTo = queryWasChanged(query, result);
      if (changedTo !== null && state.settings.skipRewritten) {
        log(
          `Q${state.queryIndex + 1} p${page}: Bing changed the query` +
          (changedTo ? ` to "${changedTo}"` : '') + ' — skipped, nothing collected.'
        );
        advanceToNextQuery();
        state.message = progressMessage('Waiting');
        await commit();
        if (state.queryIndex < state.queries.length) await sleep(CONFIG.PAGE_DELAY_MS);
        continue;
      }

      // ---- Merge links -------------------------------------------------------
      const filters = state.settings.enforceSite ? parseSiteFilters(query) : null;
      const { newForQuery, added, offTarget } = mergeLinks(result.links, filters);
      log(
        `Q${state.queryIndex + 1} p${page}: ${result.links.length} results, ` +
        `${added} new stored` +
        (offTarget ? `, ${offTarget} off-target dropped` : '') +
        ` (${state.links.length} total).`
      );

      // A page where EVERY result failed the site: check means Bing is ignoring it.
      const allOffTarget = result.links.length > 0 && offTarget === result.links.length;
      state.offTargetPages = allOffTarget ? state.offTargetPages + 1 : 0;

      // ---- Decide whether this query is finished ----------------------------
      const stopReason =
        result.noResults ? 'no results'
        : result.links.length === 0 ? 'empty page'
        : newForQuery === 0 ? 'no new links (repeating)'
        : state.offTargetPages >= CONFIG.MAX_OFF_TARGET_PAGES ? 'Bing is ignoring the site: operator'
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
  state.offTargetPages = 0;
}

/** e.g. "Query 1/5 — Page 3 — Found 12 links…" */
function progressMessage(verb) {
  const q = Math.min(state.queryIndex + 1, state.queries.length);
  return `${verb}: Query ${q}/${state.queries.length} — Page ${state.page} — Found ${state.links.length} links…`;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Page 1 -> first=1, page 2 -> first=11, page 3 -> first=21 …
 * Adds Bing's country (`cc`) / market (`setmkt`) params per the market setting.
 */
function buildSearchUrl(query, page, settings = DEFAULT_SETTINGS) {
  const first = (page - 1) * CONFIG.RESULTS_PER_PAGE + 1;
  let url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}`;

  const market = settings.market || 'auto';
  if (market === 'auto') {
    const loc = query.match(/(?:^|\s)loc:([a-z]{2})\b/i);
    if (loc) url += `&cc=${loc[1].toUpperCase()}`;
  } else if (market !== 'none') {
    const country = market.split('-')[1] || '';
    url += `&setmkt=${encodeURIComponent(market)}&cc=${encodeURIComponent(country)}`;
  }
  return url;
}

/** Lower-case, unify quotes and collapse whitespace so trivial differences don't count. */
function normalizeQuery(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Did Bing search for something other than what we asked?
 * @returns {string|null} null = query is intact; otherwise what Bing searched
 *   for instead ('' if it only showed an "Including results for" notice).
 */
function queryWasChanged(query, result) {
  if (result.bingQuery && normalizeQuery(result.bingQuery) !== normalizeQuery(query)) {
    return result.bingQuery;
  }
  return result.rewritten ? '' : null;
}

/**
 * Pull site: / -site: operators out of a query.
 *   'ip:1.2.3.4 site:com.au "bbq"'  -> { include: ['com.au'], exclude: [] }
 * Several site: operators (usually joined with OR) mean "any of these".
 * @returns {{include: string[], exclude: string[]}|null} null when there are none.
 */
function parseSiteFilters(query) {
  const include = [];
  const exclude = [];
  const re = /(?:^|[\s(])(-?)site:"?([^\s")]+)"?/gi;
  let m;
  while ((m = re.exec(query))) {
    const domain = m[2].toLowerCase().replace(/^\.+|\/.*$/g, '').replace(/^www\./, '');
    if (!domain) continue;
    (m[1] === '-' ? exclude : include).push(domain);
  }
  return include.length || exclude.length ? { include, exclude } : null;
}

/** True if `host` is `domain` or a subdomain of it (com.au matches shop.com.au). */
function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** True if the URL's host satisfies the query's site: filters. */
function passesSiteFilters(hostname, filters) {
  if (!filters) return true;
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (filters.exclude.some((d) => hostMatches(host, d))) return false;
  return filters.include.length === 0 || filters.include.some((d) => hostMatches(host, d));
}

/**
 * Normalise a URL for storage: http(s) only, no #fragment.
 * @param {string} raw
 * @param {{include: string[], exclude: string[]}|null} filters site: filters for the query
 * @returns {{url: string|null, offTarget: boolean}} url is null if invalid/blocked/off-target.
 */
function cleanUrl(raw, filters) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { url: null, offTarget: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { url: null, offTarget: false };
  if (isBlockedHost(url.hostname)) return { url: null, offTarget: false };
  if (!passesSiteFilters(url.hostname, filters)) return { url: null, offTarget: true };
  url.hash = '';
  return { url: url.href, offTarget: false };
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
 * - `offTarget`: links dropped because they don't match the query's site: filters.
 */
function mergeLinks(rawLinks, filters) {
  const seenForQuery = new Set(state.querySeen);
  const global = new Set(state.links);
  let newForQuery = 0;
  let added = 0;
  let offTarget = 0;

  for (const raw of rawLinks) {
    if (!seenForQuery.has(raw)) {
      seenForQuery.add(raw);
      newForQuery += 1;
    }
    const { url: clean, offTarget: isOff } = cleanUrl(raw, filters);
    if (isOff) offTarget += 1;
    if (clean && !global.has(clean)) {
      global.add(clean);
      state.links.push(clean);
      added += 1;
    }
  }

  state.querySeen = Array.from(seenForQuery);
  return { newForQuery, added, offTarget };
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
