/**
 * Saved leads in chrome.storage.local.
 *
 * Leads live under one key, "leads", as an object keyed by store origin, so a
 * re-scan replaces the old entry instead of adding a duplicate.
 *
 * Writes are queued so parallel saves from the bulk scanner never overwrite
 * each other (each save is a read-modify-write of the same object).
 */

const KEY = 'leads';
let queue = Promise.resolve();

/**
 * Run `fn` after every earlier write has finished.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function readAll() {
  const data = await chrome.storage.local.get(KEY);
  const leads = data[KEY];
  return leads && typeof leads === 'object' ? leads : {};
}

function keyFor(lead) {
  return lead.url || lead.input;
}

/**
 * All saved leads as an object keyed by origin.
 *
 * @returns {Promise<Record<string, object>>}
 */
export async function getLeads() {
  return readAll();
}

/**
 * Save or update one lead.
 *
 * @param {object} lead A scan result.
 * @returns {Promise<void>}
 */
export function saveLead(lead) {
  return saveLeads([lead]);
}

/**
 * Save or update several leads in one write.
 *
 * @param {object[]} leads
 * @returns {Promise<void>}
 */
export function saveLeads(leads) {
  return serialize(async () => {
    const all = await readAll();
    const savedAt = new Date().toISOString();
    for (const lead of leads) {
      const key = keyFor(lead);
      if (!key) continue;
      const prev = all[key];
      // Keep when this store was first found, so re-scans don't hide it.
      const firstScannedAt = (prev && (prev.firstScannedAt || prev.scannedAt)) || lead.firstScannedAt || lead.scannedAt;
      all[key] = { ...lead, firstScannedAt, savedAt };
    }
    await chrome.storage.local.set({ [KEY]: all });
  });
}

/**
 * Remove one lead by origin.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export function deleteLead(url) {
  return serialize(async () => {
    const all = await readAll();
    delete all[url];
    await chrome.storage.local.set({ [KEY]: all });
  });
}

/**
 * Remove every saved lead.
 *
 * @returns {Promise<void>}
 */
export function clearLeads() {
  return serialize(() => chrome.storage.local.set({ [KEY]: {} }));
}

/**
 * Number of saved leads.
 *
 * @returns {Promise<number>}
 */
export async function countLeads() {
  return Object.keys(await readAll()).length;
}

/**
 * Call `cb(leads)` whenever saved leads change (from any extension page).
 *
 * @param {(leads: Record<string, object>) => void} cb
 */
export function onLeadsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(changes[KEY].newValue || {});
  });
}

/* -------------------------------------------------------------------------- */
/* Scan history                                                               */
/* -------------------------------------------------------------------------- */

// Every finished scan is recorded here, saved or not (non-Shopify stores,
// password pages, failures), so the extension can warn before scanning a
// store again. Keyed by origin; both the typed origin and the final origin
// after redirects are recorded.
const HISTORY_KEY = 'scanHistory';

/**
 * @typedef {Object} HistoryEntry
 * @property {string} url              Final origin.
 * @property {string} firstScannedAt
 * @property {string} lastScannedAt
 * @property {number} count            Times scanned.
 * @property {string} status           Last scan status (ok, password_protected, error).
 * @property {string} error
 * @property {boolean} isShopify
 * @property {number} emails           Emails found on the last scan.
 */

async function readHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const h = data[HISTORY_KEY];
  return h && typeof h === 'object' ? h : {};
}

/**
 * Scan history keyed by origin.
 *
 * @returns {Promise<Record<string, HistoryEntry>>}
 */
export function getHistory() {
  return readHistory();
}

/**
 * Record finished scans (batch).
 *
 * @param {{ result: object, origin?: string }[]} scans `origin` is the origin that was asked for.
 * @returns {Promise<void>}
 */
export function recordScans(scans) {
  return serialize(async () => {
    const history = await readHistory();
    for (const { result, origin } of scans) {
      const at = result.scannedAt || new Date().toISOString();
      for (const key of new Set([origin, result.url].filter(Boolean))) {
        const prev = history[key];
        history[key] = {
          url: result.url || key,
          firstScannedAt: prev ? prev.firstScannedAt : at,
          lastScannedAt: at,
          count: (prev ? prev.count : 0) + 1,
          status: result.status,
          error: result.error || '',
          isShopify: !!result.isShopify,
          emails: (result.emails || []).length,
        };
      }
    }
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
  });
}

/**
 * Forget the scan history (saved leads are kept).
 *
 * @returns {Promise<void>}
 */
export function clearHistory() {
  return serialize(() => chrome.storage.local.set({ [HISTORY_KEY]: {} }));
}

/**
 * Call `cb(history)` whenever the scan history changes.
 *
 * @param {(history: Record<string, HistoryEntry>) => void} cb
 */
export function onHistoryChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[HISTORY_KEY]) cb(changes[HISTORY_KEY].newValue || {});
  });
}
