/**
 * Shopify Lead Finder: shared scanning logic.
 *
 * Everything here is plain string/regex work so the same module runs in the
 * extension pages (popup, dashboard) and in Node for tests. No DOM APIs.
 *
 * @module scanner
 */

/** Per-request timeout in milliseconds. */
export const FETCH_TIMEOUT_MS = 12000;

/** Stop reading a response body after this many bytes (~2MB). */
export const MAX_BYTES = 2 * 1024 * 1024;

/** Pages checked on every store, in addition to the homepage. */
export const EXTRA_PATHS = [
  '/pages/contact',
  '/pages/contact-us',
  '/policies/contact-information',
  '/policies/privacy-policy',
  '/policies/terms-of-service',
  '/policies/refund-policy',
  '/policies/shipping-policy',
  '/pages/about',
  '/pages/about-us',
  '/pages/faq',
];

const MAX_FOLLOWED_LINKS = 3;
const FOLLOW_RE = /contact|about|support|wholesale/i;

const EMAIL_FULL_RE = /^[a-z0-9._%+-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/;

const ASSET_EXT_RE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|json|woff2?|ttf|map)$/;
const JUNK_DOMAINS = [
  'sentry.io',
  'wixpress.com',
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'email.com',
  'yourdomain.com',
  'yourstore.com',
  'shopify.com',
  'myshopify.com',
  'godaddy.com',
];

const PERSONAL_DOMAIN_RE =
  /^(?:gmail\.com|googlemail\.com|outlook\.[a-z.]+|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|yahoo\.[a-z.]+|ymail\.com|icloud\.com|me\.com|mac\.com|proton\.me|protonmail\.(?:com|ch)|pm\.me|aol\.com|gmx\.[a-z.]+)$/;

const OWNER_WORDS = new Set(['owner', 'owners', 'founder', 'founders', 'cofounder', 'ceo']);
const BUSINESS_WORDS = new Set([
  'info', 'contact', 'contacts', 'hello', 'hi', 'sales', 'wholesale',
  'partnerships', 'partnership', 'partners', 'business', 'enquiries', 'inquiries',
]);
const SUPPORT_WORDS = new Set([
  'support', 'help', 'helpdesk', 'care', 'service', 'services', 'orders', 'order',
  'customerservice', 'customercare', 'customersupport',
]);
const NOREPLY_RE = /no-?reply|do-?not-?reply|mailer-?daemon/;

/** Tag names, from most to least interesting for outreach. */
export const TAGS = {
  OWNER: 'likely owner',
  BUSINESS: 'business',
  PERSONAL: 'personal inbox',
  SUPPORT: 'support',
  NOREPLY: 'no-reply',
};

const SOCIAL_KEYS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube', 'pinterest'];

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turn user input ("brand.com", "https://www.brand.com/products/x") into an origin.
 *
 * @param {string} input Raw text from the user.
 * @returns {{ ok: true, origin: string } | { ok: false, error: string }}
 */
export function normalizeInput(input) {
  const invalid = { ok: false, error: 'Invalid URL' };
  if (typeof input !== 'string') return invalid;
  let s = input.trim().replace(/^[<("'\s]+|[>)"',;\s]+$/g, '');
  if (!s) return { ok: false, error: 'Empty input' };
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    return invalid;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return invalid;
  const host = u.hostname.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]+)$/.test(host)) {
    return invalid;
  }
  return { ok: true, origin: u.origin.toLowerCase() };
}

/**
 * Parse a pasted block of URLs (one per line or comma separated) into unique origins.
 *
 * @param {string} text
 * @returns {{ origins: string[], invalid: string[], duplicates: number }}
 */
export function parseUrlList(text) {
  const tokens = String(text || '')
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set();
  const origins = [];
  const invalid = [];
  let duplicates = 0;
  for (const t of tokens) {
    const n = normalizeInput(t);
    if (!n.ok) {
      invalid.push(t);
    } else if (seen.has(n.origin)) {
      duplicates++;
    } else {
      seen.add(n.origin);
      origins.push(n.origin);
    }
  }
  return { origins, invalid, duplicates };
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Page
 * @property {boolean} ok        HTTP 2xx and an HTML-ish body.
 * @property {number}  status    HTTP status, 0 on network failure.
 * @property {string}  url       Final URL after redirects.
 * @property {?Headers} headers
 * @property {string}  html      Body text (capped at MAX_BYTES), '' when not read.
 * @property {boolean} isHtml
 * @property {string}  contentType
 * @property {('timeout'|'aborted'|'network'|undefined)} error
 */

/**
 * Read a response body as text, stopping after `maxBytes`.
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      const keep = value.byteLength - (received - maxBytes);
      out += decoder.decode(value.subarray(0, keep), { stream: true });
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * Fetch one page with a timeout. Never throws.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<Page>}
 */
export async function fetchPage(url, { signal, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    });
    const contentType = (res.headers && res.headers.get('content-type')) || '';
    const isHtml = !contentType || /html|xml|text\/plain/i.test(contentType);
    let html = '';
    if (isHtml && (res.ok || res.status === 401)) {
      html = await readCapped(res, MAX_BYTES);
    } else if (res.body && typeof res.body.cancel === 'function') {
      res.body.cancel().catch(() => {});
    }
    return {
      ok: res.ok && isHtml,
      status: res.status,
      url: res.url || url,
      headers: res.headers || null,
      html,
      isHtml,
      contentType,
      error: undefined,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      url,
      headers: null,
      html: '',
      isHtml: false,
      contentType: '',
      error: timedOut ? 'timeout' : signal && signal.aborted ? 'aborted' : 'network',
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Human-readable reason a homepage fetch failed.
 *
 * @param {Page} page
 * @param {number} timeoutMs
 * @returns {string}
 */
function describeFailure(page, timeoutMs) {
  if (page.error === 'timeout') return `Timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (page.error === 'aborted') return 'Scan stopped';
  if (page.error === 'network') {
    return "Couldn't connect. The site may be down, blocking requests, or the domain may not exist";
  }
  if (page.status === 404 || page.status === 410) return `Store not found (${page.status})`;
  if (page.status === 401 || page.status === 403 || page.status === 429) {
    return `Blocked by the site (${page.status})`;
  }
  if (page.status >= 500) return `The site returned an error (${page.status})`;
  if (!page.isHtml) return `Not a web page (${page.contentType.split(';')[0] || 'unknown type'})`;
  return `Request failed (${page.status})`;
}

/* -------------------------------------------------------------------------- */
/* HTML helpers                                                               */
/* -------------------------------------------------------------------------- */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', middot: '·', bull: '•', raquo: '»', laquo: '«',
  commat: '@', period: '.', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

function codePointToString(cp) {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

/**
 * Decode HTML character references (&amp;, &#64;, &#x40;, ...).
 *
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => codePointToString(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => codePointToString(parseInt(d, 10)))
    .replace(/&([a-z]{2,10});/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

/**
 * Undo the common ways an "@" or "." gets hidden in page source:
 * HTML entities, URL encoding and JS/JSON escapes.
 *
 * @param {string} html
 * @returns {string}
 */
export function decodeObfuscation(html) {
  return decodeEntities(
    String(html)
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
  )
    .replace(/%40/gi, '@')
    .replace(/%2e/gi, '.');
}

/**
 * Parse the attributes of a single start tag.
 *
 * @param {string} tag e.g. `<meta property="og:site_name" content="Brand">`
 * @returns {Record<string, string>}
 */
function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  while ((m = re.exec(tag))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

function getMetaContent(html, key) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = parseAttrs(m[0]);
    const k = (a.property || a.name || '').toLowerCase();
    if (k === key && a.content) return a.content;
  }
  return '';
}

function cleanText(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/**
 * Strip "Home" style fragments from a page title: "Brand – Home" → "Brand".
 *
 * @param {string} title
 * @returns {string}
 */
export function cleanTitle(title) {
  const s = cleanText(title);
  if (!s) return '';
  const parts = s.split(/\s+[–—|:·•»-]\s+/).map((p) => p.trim()).filter(Boolean);
  const generic = /^(?:home|home ?page|welcome|official (?:site|store|website)|online (?:store|shop)|shop|store|index)$/i;
  const kept = parts.filter((p) => !generic.test(p));
  return (kept[0] || parts[0] || s).trim();
}

/**
 * Store name from og:site_name, falling back to the <title>, then the hostname.
 *
 * @param {string} html
 * @param {string} host
 * @returns {string}
 */
export function extractStoreName(html, host = '') {
  const og = cleanText(getMetaContent(html, 'og:site_name'));
  if (og) return og;
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const fromTitle = t ? cleanTitle(t[1]) : '';
  if (fromTitle) return fromTitle;
  return host.replace(/^www\./, '');
}

/* -------------------------------------------------------------------------- */
/* Shopify detection                                                          */
/* -------------------------------------------------------------------------- */

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return hit ? String(headers[hit]) : '';
}

/**
 * Decide whether a homepage belongs to a Shopify store.
 *
 * @param {string} html
 * @param {Headers|Record<string,string>|null} headers
 * @returns {{ isShopify: boolean, myshopifyDomain: string }}
 */
export function detectShopify(html, headers) {
  const markers = ['cdn.shopify.com', 'Shopify.shop', 'Shopify.theme', 'shopify-digital-wallet'];
  const htmlHit = markers.some((m) => html.includes(m));
  const headerHit =
    !!headerValue(headers, 'x-shopid') ||
    !!headerValue(headers, 'x-shopify-stage') ||
    /shopify/i.test(headerValue(headers, 'powered-by'));

  let myshopifyDomain = '';
  const m =
    html.match(/Shopify\.shop\s*=\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i) ||
    html.match(/["']?(?:myshopify_?domain|permanent_domain)["']?\s*[:=]\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i);
  if (m) myshopifyDomain = m[1].toLowerCase();

  return { isShopify: htmlHit || headerHit, myshopifyDomain };
}

/**
 * True when the page is Shopify's storefront password page.
 *
 * @param {string} finalUrl
 * @param {string} html
 * @returns {boolean}
 */
export function isPasswordPage(finalUrl, html) {
  try {
    if (/^\/password\/?$/i.test(new URL(finalUrl).pathname)) return true;
  } catch {
    /* ignore */
  }
  return /value=["']storefront_password["']|class=["'][^"']*\btemplate-password\b/i.test(html);
}

/* -------------------------------------------------------------------------- */
/* Emails                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Decode a Cloudflare "email protection" hex string. The first byte is the
 * XOR key for every byte after it.
 *
 * @param {string} hex
 * @returns {string|null}
 */
export function decodeCfEmail(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

/**
 * Clean one candidate: lowercase, trim stray punctuation, validate shape.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeEmail(raw) {
  let e = String(raw || '').trim().toLowerCase();
  e = e.replace(/^mailto:/, '');
  e = e.replace(/^(?:%[0-9a-f]{2})+/, '');
  e = e.replace(/^[._%+-]+/, '');
  e = e.replace(/\.+$/, '');
  return EMAIL_FULL_RE.test(e) ? e : null;
}

const DOT_PAT = String.raw`(?:\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*|\.)`;
const DOT_RE = new RegExp(DOT_PAT, 'gi');
const OBF_DOMAIN_RE = new RegExp(String.raw`^\s*([a-z0-9-]+(?:${DOT_PAT}[a-z0-9-]+)+)`, 'i');
const AT_MARKER_RE = /[\[\(\{]\s{0,5}at\s{0,5}[\]\)\}]/gi;
const DOMAIN_TAIL_RE = /^[a-z0-9.-]+\.[a-z]{2,24}/i;

function isLocalChar(c) {
  // a-z A-Z 0-9 . _ % + -
  return (
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
    c === 46 || c === 95 || c === 37 || c === 43 || c === 45
  );
}

function isDomainChar(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 46 || c === 45;
}

/**
 * Find plain addresses by anchoring on each "@" and walking outwards.
 * Equivalent to /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi but linear time,
 * so multi-megabyte pages with long base64 blobs can't stall the scan.
 *
 * @param {string} text
 * @param {(raw: string) => void} add
 */
function scanPlainEmails(text, add) {
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let start = at;
    const minStart = Math.max(0, at - 64);
    while (start > minStart && isLocalChar(text.charCodeAt(start - 1))) start--;
    if (start === at) continue;
    if (start === minStart && start > 0 && isLocalChar(text.charCodeAt(start - 1))) continue; // local part > 64
    let end = at + 1;
    const maxEnd = Math.min(text.length, at + 254);
    while (end < maxEnd && isDomainChar(text.charCodeAt(end))) end++;
    const domain = text.slice(at + 1, end).match(DOMAIN_TAIL_RE);
    if (domain) add(text.slice(start, at) + '@' + domain[0]);
  }
}

/**
 * Find "name [at] domain [dot] com" style addresses ("(at)" and "{at}" too).
 *
 * @param {string} text
 * @param {(raw: string) => void} add
 */
function scanObfuscatedEmails(text, add) {
  for (const m of text.matchAll(AT_MARKER_RE)) {
    const before = text.slice(Math.max(0, m.index - 80), m.index).replace(/\s+$/, '');
    const local = before.match(/[a-z0-9._%+-]{1,64}$/i);
    if (!local) continue;
    const afterStart = m.index + m[0].length;
    const domain = text.slice(afterStart, afterStart + 260).match(OBF_DOMAIN_RE);
    if (domain) add(`${local[0]}@${domain[1].replace(DOT_RE, '.')}`);
  }
}

/**
 * Pull every email address out of a page's raw HTML. Handles plain text,
 * mailto: links, HTML/URL/JS escapes, Cloudflare email protection and
 * "name [at] domain [dot] com" style obfuscation. Junk is not removed here;
 * see {@link isJunkEmail}.
 *
 * @param {string} html
 * @returns {string[]} Unique, normalized addresses in order of appearance.
 */
export function extractEmails(html) {
  const found = new Set();
  const add = (raw) => {
    const e = normalizeEmail(raw);
    if (e) found.add(e);
  };
  const src = String(html || '');

  // Cloudflare: data-cfemail="hex" and /cdn-cgi/l/email-protection#hex
  for (const m of src.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) add(decodeCfEmail(m[1]));
  for (const m of src.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) add(decodeCfEmail(m[1]));

  const text = decodeObfuscation(src).replace(/\u00a0/g, ' ');

  // mailto: links, with ?subject=... stripped. May hold several addresses.
  for (const m of text.matchAll(/mailto:([^"'<>\s]+)/gi)) {
    let v = m[1].split('?')[0];
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep as is */
    }
    v.split(/[,;]/).forEach(add);
  }

  scanObfuscatedEmails(text, add);
  scanPlainEmails(text, add);

  return [...found];
}

/**
 * True for addresses that are clearly not real contacts: asset filenames
 * (logo@2x.png), placeholder or vendor domains, and hash-like local parts.
 *
 * @param {string} email Normalized address.
 * @returns {boolean}
 */
export function isJunkEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return true;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (ASSET_EXT_RE.test(email)) return true;
  if (JUNK_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return true;
  if (/(?:^|\.)sentry(?:-next)?\./.test(domain)) return true;
  if (local.length > 64) return true;
  if (/[0-9a-f]{24,}/.test(local)) return true;
  return false;
}

/**
 * Lowercase letters and digits only, used to compare store names with local parts.
 *
 * @param {string} s
 * @returns {string}
 */
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

function domainsMatch(a, b) {
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

/**
 * @typedef {Object} ScoreContext
 * @property {string[]} storeDomains Hostnames of the store, without "www.".
 * @property {string[]} storeSlugs   Store name variants as slugs (see slug()).
 */

/**
 * Score one email for "how likely is this to reach the owner".
 *
 * @param {string} email
 * @param {string[]} sources Page paths the address was found on.
 * @param {ScoreContext} ctx
 * @returns {{ score: number, tag: string }}
 */
export function scoreEmail(email, sources, ctx) {
  const [local, domain] = email.split('@');
  const tokens = local.split(/[._+-]+/).filter(Boolean);
  const compact = slug(local);
  const hasWord = (set) => set.has(compact) || tokens.some((t) => set.has(t));

  const onStoreDomain = ctx.storeDomains.some((d) => d && domainsMatch(domain, d));
  const isOwner =
    hasWord(OWNER_WORDS) ||
    ctx.storeSlugs.some((s) => s.length >= 3 && (compact === s || tokens.includes(s)));
  const isBusiness = hasWord(BUSINESS_WORDS);
  const isPersonal = PERSONAL_DOMAIN_RE.test(domain);
  const isSupport = hasWord(SUPPORT_WORDS);
  const onContactPage = sources.some((p) => /contact/i.test(p));
  const isNoReply = NOREPLY_RE.test(local);

  let score = 0;
  if (onStoreDomain) score += 3;
  if (isOwner) score += 3;
  if (isBusiness) score += 2;
  if (isPersonal) score += 2;
  if (isSupport) score += 1;
  if (onContactPage) score += 1;
  if (isNoReply) score -= 5;

  let tag;
  if (isNoReply) tag = TAGS.NOREPLY;
  else if (isOwner) tag = TAGS.OWNER;
  else if (isPersonal) tag = TAGS.PERSONAL;
  else if (isSupport && !isBusiness) tag = TAGS.SUPPORT;
  else tag = TAGS.BUSINESS;

  return { score, tag };
}

/**
 * Build the scored, filtered, sorted email list from per-page findings.
 *
 * @param {Map<string, Set<string>>} emailSources email → set of page paths
 * @param {ScoreContext} ctx
 * @returns {{ email: string, score: number, tag: string, sources: string[] }[]}
 */
export function rankEmails(emailSources, ctx) {
  const list = [];
  for (const [email, paths] of emailSources) {
    if (isJunkEmail(email)) continue;
    const sources = [...paths];
    list.push({ email, ...scoreEmail(email, sources, ctx), sources });
  }
  list.sort(
    (a, b) =>
      b.score - a.score || b.sources.length - a.sources.length || a.email.localeCompare(b.email)
  );
  return list;
}

/* -------------------------------------------------------------------------- */
/* Phones and socials                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Phone numbers from tel: links only, normalized to "+digits" or "digits".
 *
 * @param {string} html
 * @returns {string[]}
 */
export function extractPhones(html) {
  const out = [];
  const seen = new Set();
  const text = decodeEntities(String(html || ''));
  for (const m of text.matchAll(/href\s*=\s*["']\s*tel:([^"']+)["']/gi)) {
    let v = m[1];
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep */
    }
    v = v.split(/[?;,]|ext|x/i)[0];
    const plus = v.trim().startsWith('+');
    const digits = v.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push((plus ? '+' : '') + digits);
  }
  return out;
}

const SHARE_RE = /sharer|share\?|\/share(?:\/|$)|sharearticle|intent\/tweet|\/intent\/|\/p\/|\/reels?\/|\/watch|\/embed|\/plugins\/|\/dialog\//i;
const RESERVED = {
  instagram: new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'direct', 'about', 'legal', 'developer', 'embed.js']),
  facebook: new Set(['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login', 'l.php', 'hashtag', 'watch', 'events', 'help', 'policies', 'privacy', 'business', 'ads', 'photo.php', 'story.php', 'permalink.php', 'video.php']),
  x: new Set(['intent', 'share', 'home', 'hashtag', 'search', 'i', 'explore', 'settings', 'login', 'signup', 'tos', 'privacy', 'widgets', 'widgets.js']),
  pinterest: new Set(['pin', 'search', 'ideas', 'today', 'explore', 'business', 'login', 'settings', 'js']),
};

function hostIs(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/**
 * Classify a URL as one of the supported social profiles.
 *
 * @param {string} raw
 * @returns {{ network: string, url: string } | null}
 */
export function classifySocial(raw) {
  let u;
  try {
    u = new URL(raw.startsWith('//') ? 'https:' + raw : raw);
  } catch {
    return null;
  }
  if (SHARE_RE.test(u.pathname + u.search)) return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const first = segs[0] || '';
  const lower = first.toLowerCase();

  if (hostIs(host, 'instagram.com')) {
    if (/^[a-z0-9_.]{1,30}$/i.test(first) && !RESERVED.instagram.has(lower)) {
      return { network: 'instagram', url: `https://www.instagram.com/${first}` };
    }
  } else if (hostIs(host, 'facebook.com') || hostIs(host, 'fb.com')) {
    if (lower === 'profile.php') {
      const id = u.searchParams.get('id');
      if (id && /^\d+$/.test(id)) return { network: 'facebook', url: `https://www.facebook.com/profile.php?id=${id}` };
    } else if (lower === 'pages' && segs.length >= 2) {
      return { network: 'facebook', url: `https://www.facebook.com/${segs.slice(0, 3).join('/')}` };
    } else if (first && !RESERVED.facebook.has(lower) && /^[a-z0-9.\-_]+$/i.test(first) && !/\.php$/i.test(first)) {
      return { network: 'facebook', url: `https://www.facebook.com/${first}` };
    }
  } else if (hostIs(host, 'tiktok.com')) {
    if (/^@[a-z0-9_.]{2,24}$/i.test(first)) return { network: 'tiktok', url: `https://www.tiktok.com/${first}` };
  } else if (hostIs(host, 'linkedin.com')) {
    if (/^(?:company|in|showcase|school)$/.test(lower) && segs[1]) {
      return { network: 'linkedin', url: `https://www.linkedin.com/${lower}/${segs[1]}` };
    }
  } else if (hostIs(host, 'twitter.com') || hostIs(host, 'x.com')) {
    if (/^[a-z0-9_]{1,15}$/i.test(first) && !RESERVED.x.has(lower)) {
      return { network: 'x', url: `https://x.com/${first}` };
    }
  } else if (hostIs(host, 'youtube.com')) {
    if (first.startsWith('@') && first.length > 1) return { network: 'youtube', url: `https://www.youtube.com/${first}` };
    if (/^(?:channel|c|user)$/.test(lower) && segs[1]) {
      return { network: 'youtube', url: `https://www.youtube.com/${lower}/${segs[1]}` };
    }
  } else if (/(?:^|\.)pinterest\.[a-z.]{2,6}$/.test(host)) {
    if (/^[a-z0-9_]{3,30}$/i.test(first) && !RESERVED.pinterest.has(lower)) {
      return { network: 'pinterest', url: `https://www.pinterest.com/${first}` };
    }
  }
  return null;
}

/**
 * First profile link per network across the given pages (homepage first).
 *
 * @param {string[]} htmlPages
 * @returns {{ instagram: string|null, facebook: string|null, tiktok: string|null, linkedin: string|null, x: string|null, youtube: string|null, pinterest: string|null }}
 */
export function extractSocials(htmlPages) {
  const socials = Object.fromEntries(SOCIAL_KEYS.map((k) => [k, null]));
  const urlRe = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>\\)]*)?/gi;
  for (const html of htmlPages) {
    const text = decodeEntities(String(html || '').replace(/\\\//g, '/'));
    for (const m of text.matchAll(urlRe)) {
      const hit = classifySocial(m[0]);
      if (hit && !socials[hit.network]) socials[hit.network] = hit.url;
    }
    if (SOCIAL_KEYS.every((k) => socials[k])) break;
  }
  return socials;
}

/**
 * Up to `limit` same-origin links from the homepage that look like contact,
 * about, support or wholesale pages, excluding paths already queued.
 *
 * @param {string} html
 * @param {string} origin
 * @param {Set<string>} exclude Lowercased paths without trailing slash.
 * @param {number} [limit]
 * @returns {string[]} Paths (with query string when present).
 */
export function findFollowLinks(html, origin, exclude, limit = MAX_FOLLOWED_LINKS) {
  const out = [];
  const seen = new Set(exclude);
  for (const m of String(html).matchAll(/<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi)) {
    const href = decodeEntities(parseAttrs(m[1]).href || '').trim();
    if (!href || href.startsWith('#') || /^(?:mailto|tel|javascript):/i.test(href)) continue;
    const label = m[2].replace(/<[^>]*>/g, ' ');
    if (!FOLLOW_RE.test(href) && !FOLLOW_RE.test(label)) continue;
    let u;
    try {
      u = new URL(href, origin + '/');
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    if (/\.(?:pdf|jpe?g|png|gif|webp|svg|zip|mp4)$/i.test(u.pathname)) continue;
    const key = u.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    if (key === '/' || seen.has(key)) continue;
    seen.add(key);
    out.push(u.pathname + u.search);
    if (out.length >= limit) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ScanResult
 * @property {string}  input
 * @property {string}  url              Canonical origin after redirects.
 * @property {string}  storeName
 * @property {boolean} isShopify
 * @property {string}  myshopifyDomain
 * @property {{ email: string, score: number, tag: string, sources: string[] }[]} emails
 * @property {string|null} bestEmail    Highest scoring address, null when none (or only no-reply).
 * @property {string[]} phones
 * @property {Record<string, string|null>} socials
 * @property {string[]} pagesChecked    Paths that returned a readable page.
 * @property {'ok'|'password_protected'|'error'} status
 * @property {string}  error            Readable message when status isn't "ok".
 * @property {string}  scannedAt        ISO timestamp.
 */

function emptyResult(input) {
  return {
    input: String(input ?? ''),
    url: '',
    storeName: '',
    isShopify: false,
    myshopifyDomain: '',
    emails: [],
    bestEmail: null,
    phones: [],
    socials: Object.fromEntries(SOCIAL_KEYS.map((k) => [k, null])),
    pagesChecked: [],
    status: 'error',
    error: '',
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Fill emails, phones and socials on `result` from the fetched pages.
 *
 * @param {ScanResult} result
 * @param {{ path: string, html: string }[]} pages
 * @param {string[]} hosts
 */
function collectContacts(result, pages, hosts) {
  const emailSources = new Map();
  for (const { path, html } of pages) {
    for (const email of extractEmails(html)) {
      if (!emailSources.has(email)) emailSources.set(email, new Set());
      emailSources.get(email).add(path);
    }
  }

  const storeDomains = [...new Set(hosts.map((h) => h.replace(/^www\./, '')))];
  const storeSlugs = new Set([slug(result.storeName)]);
  for (const d of storeDomains) {
    const label = d.split('.')[0];
    if (!/^(?:shop|store|www)$/.test(label)) storeSlugs.add(slug(label));
  }
  if (result.myshopifyDomain) storeSlugs.add(slug(result.myshopifyDomain.split('.')[0]));

  result.emails = rankEmails(emailSources, { storeDomains, storeSlugs: [...storeSlugs] });
  result.bestEmail = result.emails.length && result.emails[0].score >= 0 ? result.emails[0].email : null;

  const seen = new Set();
  for (const { html } of pages) {
    for (const p of extractPhones(html)) {
      const k = p.replace(/\D/g, '');
      if (!seen.has(k)) {
        seen.add(k);
        result.phones.push(p);
      }
    }
  }
  result.socials = extractSocials(pages.map((p) => p.html));
}

/**
 * Scan one store for publicly listed contact details. Never throws: failures
 * come back as `status: "error"` with a readable `error` message.
 *
 * @param {string} input Store URL or domain as typed by the user.
 * @param {Object} [options]
 * @param {(p: { step: 'homepage'|'page'|'done', path: string, done?: number, total?: number }) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]   Abort to stop the scan and all in-flight requests.
 * @param {typeof fetch} [options.fetchImpl] Override fetch (used by tests).
 * @param {number} [options.timeoutMs]    Per-request timeout, default 12s.
 * @returns {Promise<ScanResult>}
 */
export async function scanStore(input, { onProgress, signal, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const result = emptyResult(input);
  const progress = (p) => {
    try {
      if (onProgress) onProgress(p);
    } catch {
      /* a UI bug must not break the scan */
    }
  };
  const stopped = () => {
    result.status = 'error';
    result.error = 'Scan stopped';
    return result;
  };

  try {
    const norm = normalizeInput(input);
    if (!norm.ok) {
      result.error = norm.error === 'Empty input' ? 'Empty input' : 'Invalid URL';
      return result;
    }
    result.url = norm.origin;
    const inputHost = new URL(norm.origin).hostname;
    if (signal && signal.aborted) return stopped();

    // 1. Homepage
    progress({ step: 'homepage', path: '/' });
    const home = await fetchPage(norm.origin + '/', { signal, fetchImpl, timeoutMs });
    if (signal && signal.aborted) return stopped();

    let finalUrl = home.url || norm.origin + '/';
    let origin = norm.origin;
    try {
      const f = new URL(finalUrl);
      if (f.protocol === 'https:' || f.protocol === 'http:') origin = f.origin;
    } catch {
      finalUrl = norm.origin + '/';
    }
    result.url = origin;
    const hosts = [inputHost, new URL(origin).hostname];

    const passwordProtected = !!home.html && isPasswordPage(finalUrl, home.html);
    if (!passwordProtected && !home.ok) {
      result.error = describeFailure(home, timeoutMs);
      return result;
    }

    const shop = detectShopify(home.html, home.headers);
    result.isShopify = shop.isShopify || passwordProtected;
    result.myshopifyDomain = shop.myshopifyDomain;
    result.storeName = extractStoreName(home.html, new URL(origin).hostname);

    if (passwordProtected) {
      // The password page itself sometimes lists a contact email.
      result.pagesChecked = ['/password'];
      collectContacts(result, [{ path: '/password', html: home.html }], hosts);
      result.status = 'password_protected';
      result.error = 'Store password protected';
      result.scannedAt = new Date().toISOString();
      progress({ step: 'done', path: '/password', done: 1, total: 1 });
      return result;
    }

    // 2. Known pages + up to 3 contact-ish links from the homepage, in parallel.
    const queued = new Set(['/', ...EXTRA_PATHS.map((p) => p.toLowerCase())]);
    const followed = findFollowLinks(home.html, origin, queued);
    const paths = [...EXTRA_PATHS, ...followed];
    const total = paths.length + 1;
    let done = 1;
    progress({ step: 'page', path: '/', done, total });

    const subpages = await Promise.all(
      paths.map(async (path) => {
        const page = await fetchPage(origin + path, { signal, fetchImpl, timeoutMs });
        done++;
        progress({ step: 'page', path, done, total });
        return { path, page };
      })
    );
    if (signal && signal.aborted) return stopped();

    const pages = [{ path: '/', html: home.html }];
    for (const { path, page } of subpages) {
      if (page.ok && page.html && !isPasswordPage(page.url, page.html)) pages.push({ path, html: page.html });
    }
    result.pagesChecked = pages.map((p) => p.path);

    // 3. Extract
    collectContacts(result, pages, hosts);
    result.status = 'ok';
    result.error = '';
    result.scannedAt = new Date().toISOString();
    progress({ step: 'done', path: '', done: total, total });
    return result;
  } catch (err) {
    if (signal && signal.aborted) return stopped();
    result.status = 'error';
    result.error = `Unexpected error: ${(err && err.message) || String(err)}`;
    return result;
  }
}
