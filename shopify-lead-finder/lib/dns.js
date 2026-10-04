/**
 * DNS lookups over HTTPS (DoH), and the "is this store on Crazy Domains?" check.
 *
 * Extension pages can't make raw DNS queries, so records are fetched as JSON
 * from Google's resolver (https://dns.google/resolve), with Cloudflare
 * (https://cloudflare-dns.com/dns-query) as a fallback if Google fails.
 *
 * Results are cached in chrome.storage.local, so a domain is only looked up
 * once per CACHE_TTL_MS. The cache is skipped when chrome.storage isn't
 * available (Node tests).
 *
 * @module dns
 */

/** Per-request timeout for a DoH query. */
export const DNS_TIMEOUT_MS = 8000;

/** How long a cached Crazy Domains result is reused. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** DNS record type numbers used in DoH JSON answers. */
const TYPE_NS = 2;
const TYPE_MX = 15;

/** Signals that a domain uses Crazy Domains nameservers. */
const CD_NS_PATTERNS = [/crazydomains\.com/i, /syrahost\.com/i, /premium\.exchange/i, /dnspackage\.com/i];

/** Signals that a domain uses Crazy Domains email hosting. */
const CD_MX_PATTERNS = [/ds\.network/i, /crazydomains/i, /xion\.oxcs\.net/i];

/** DoH endpoints, tried in order. Both accept ?name=&type= and return the same JSON shape. */
const RESOLVERS = [
  (name, type) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  (name, type) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
];

/* -------------------------------------------------------------------------- */
/* Raw DoH queries                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Query one resolver with a timeout. Throws on network errors, timeouts and
 * non-2xx responses so the caller can try the next resolver.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<object>} Parsed DoH JSON.
 */
async function fetchDoh(url, { signal, fetchImpl, timeoutMs = DNS_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      headers: { Accept: 'application/dns-json' },
    });
    if (!res.ok) throw new Error(`DNS resolver returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Look up records of one type, trying Google first and Cloudflare second.
 * A domain that simply has no records of this type returns an empty list.
 * Throws only when every resolver failed.
 *
 * @param {string} name   Domain name, e.g. "brand.com".
 * @param {number} type   Record type number (2 = NS, 15 = MX).
 * @param {object} [opts] { signal, fetchImpl, timeoutMs }
 * @returns {Promise<string[]>} Record data strings, e.g. "10 mail.brand.com." for MX.
 */
export async function queryDns(name, type, opts = {}) {
  let lastError;
  for (const makeUrl of RESOLVERS) {
    if (opts.signal && opts.signal.aborted) throw new Error('DNS lookup stopped');
    try {
      const json = await fetchDoh(makeUrl(name, type), opts);
      // Status 0 = NOERROR, 3 = NXDOMAIN (no such domain). Both are real answers.
      return (json.Answer || []).filter((a) => a.type === type).map((a) => String(a.data || ''));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`DNS lookup failed for ${name}: ${(lastError && lastError.message) || 'unknown error'}`);
}

/** Lowercase hostname without the trailing dot. */
function cleanHost(h) {
  return String(h || '').trim().replace(/\.$/, '').toLowerCase();
}

/**
 * Nameserver hostnames for a domain.
 *
 * @param {string} domain
 * @param {object} [opts]
 * @returns {Promise<string[]>}
 */
export async function getNsRecords(domain, opts) {
  return (await queryDns(domain, TYPE_NS, opts)).map(cleanHost).filter(Boolean);
}

/**
 * Mail server hostnames for a domain, lowest priority number first.
 * MX data looks like "10 mx1.brand.com."; only the hostname is returned.
 *
 * @param {string} domain
 * @param {object} [opts]
 * @returns {Promise<string[]>}
 */
export async function getMxRecords(domain, opts) {
  return (await queryDns(domain, TYPE_MX, opts))
    .map((d) => {
      const [prio, host] = d.trim().split(/\s+/);
      return { prio: Number(prio) || 0, host: cleanHost(host) };
    })
    .filter((r) => r.host)
    .sort((a, b) => a.prio - b.prio)
    .map((r) => r.host);
}

/* -------------------------------------------------------------------------- */
/* Domain helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Domains to try for NS/MX, most specific first: "shop.brand.com.au" →
 * ["shop.brand.com.au", "brand.com.au", "com.au"]. NS records live on the
 * zone apex, so a subdomain (www., shop.) usually has none of its own.
 * "www." is dropped up front.
 *
 * @param {string} hostOrUrl Hostname or URL.
 * @returns {string[]}
 */
export function domainCandidates(hostOrUrl) {
  let host = String(hostOrUrl || '').trim().toLowerCase();
  try {
    if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    return [];
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  const labels = host.split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Crazy Domains detection                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} HostingCheck
 * @property {boolean} detected
 * @property {string}  [evidence]  The NS or MX hostname that matched.
 * @property {'nameserver'|'mx'} [type]
 * @property {string}  [error]     Set when the DNS lookups failed (detected is false).
 */

/**
 * Work out whether a domain uses Crazy Domains infrastructure:
 *   1. NS records: crazydomains.com, syrahost.com, premium.exchange, dnspackage.com
 *   2. If no nameserver matched, MX records: ds.network, crazydomains, xion.oxcs.net
 *
 * NS is checked on the first domain (from domainCandidates) that has NS
 * records; MX on the same domain. Never throws: a failed lookup comes back
 * as { detected: false, error }.
 *
 * @param {string} domain Hostname or URL, e.g. "www.brand.com.au".
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<HostingCheck>}
 */
export async function lookupCrazyDomains(domain, opts = {}) {
  const candidates = domainCandidates(domain);
  if (!candidates.length) return { detected: false, error: 'Invalid domain' };

  let nsFailed = false;
  let zone = candidates[0];

  // 1. Nameservers: walk up from the full host to the first zone that has NS records.
  try {
    for (const name of candidates) {
      const ns = await getNsRecords(name, opts);
      if (!ns.length) continue;
      zone = name;
      const hit = ns.find((h) => CD_NS_PATTERNS.some((re) => re.test(h)));
      if (hit) return { detected: true, evidence: hit, type: 'nameserver' };
      break; // found the zone's nameservers and none matched: fall back to MX
    }
  } catch {
    nsFailed = true;
  }

  // 2. Mail servers on the same zone.
  try {
    const mx = await getMxRecords(zone, opts);
    const hit = mx.find((h) => CD_MX_PATTERNS.some((re) => re.test(h)));
    if (hit) return { detected: true, evidence: hit, type: 'mx' };
  } catch (err) {
    // Both lookups failed: we can't tell, so report an error rather than "not detected".
    if (nsFailed) return { detected: false, error: err.message || 'DNS lookup failed' };
  }
  return { detected: false };
}

/* ------------------------------- caching ---------------------------------- */

const CACHE_KEY = 'dnsCache';
/** In-memory copy of the cache, loaded once per page. */
let memCache = null;
/** The single load from storage, shared by all callers so parallel lookups wait for it. */
let loading = null;
/** Lookups in progress, so two scans of the same domain share one query. */
const inFlight = new Map();
/** Serializes cache writes so parallel lookups don't overwrite each other. */
let writeQueue = Promise.resolve();

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

function loadCache() {
  if (!loading) {
    loading = (async () => {
      let stored = {};
      if (hasChromeStorage()) {
        try {
          stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
        } catch {
          /* start empty */
        }
      }
      memCache = stored;
      return memCache;
    })();
  }
  return loading;
}

function persistCache() {
  if (!hasChromeStorage()) return;
  writeQueue = writeQueue
    .then(() => chrome.storage.local.set({ [CACHE_KEY]: memCache }))
    .catch(() => {});
}

/**
 * Cached version of lookupCrazyDomains(). Successful answers (detected or
 * not) are kept for CACHE_TTL_MS; failed lookups aren't cached, so they are
 * retried next time.
 *
 * @param {string} domain Hostname or URL.
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<HostingCheck>}
 */
export async function isCrazyDomainsHosted(domain, opts = {}) {
  const key = domainCandidates(domain)[0];
  if (!key) return { detected: false, error: 'Invalid domain' };

  const cache = await loadCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  if (inFlight.has(key)) return inFlight.get(key);
  const p = lookupCrazyDomains(key, opts)
    .then((result) => {
      if (!result.error) {
        cache[key] = { result, at: Date.now() };
        persistCache();
      }
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Badge text for a match: "Crazy Domains (NS)" or "Crazy Domains (MX)".
 *
 * @param {HostingCheck|null|undefined} check
 * @returns {string} '' when not detected.
 */
export function hostingLabel(check) {
  if (!check || !check.detected) return '';
  return `Crazy Domains (${check.type === 'mx' ? 'MX' : 'NS'})`;
}

/* --------------------------------- setting -------------------------------- */

/** chrome.storage.local key for the "Only show Crazy Domains hosted stores" toggle. */
export const CD_ONLY_KEY = 'onlyCrazyDomains';

/** Read the toggle (false when unset or storage is unavailable). */
export async function getCrazyDomainsOnly() {
  if (!hasChromeStorage()) return false;
  try {
    return !!(await chrome.storage.local.get(CD_ONLY_KEY))[CD_ONLY_KEY];
  } catch {
    return false;
  }
}

/** Save the toggle. The popup and the bulk scanner share it. */
export async function setCrazyDomainsOnly(on) {
  if (hasChromeStorage()) await chrome.storage.local.set({ [CD_ONLY_KEY]: !!on });
}
