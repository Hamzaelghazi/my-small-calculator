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
      if (key) all[key] = { ...lead, savedAt };
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
