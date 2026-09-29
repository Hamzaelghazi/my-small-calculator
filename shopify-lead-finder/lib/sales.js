/**
 * Rough store-size estimate from public signals.
 *
 * No store publishes its revenue, so this is a heuristic: catalog size and
 * prices (from Shopify's public /meta.json and /products.json), the paid
 * marketing apps and ad pixels on the homepage, and how many countries the
 * store ships to. The result is a size tier with a monthly sales range and a
 * suggested offer level, meant for sorting prospects, not for reporting.
 *
 * Pure functions, no DOM, so it runs in Node tests too.
 *
 * @module sales
 */

/**
 * Size tiers, smallest first. `min` is the minimum signal score.
 * @type {{ id: string, label: string, range: string, offer: string, min: number }[]}
 */
export const SIZE_TIERS = [
  { id: 'early', label: 'Early', range: 'under $5k/mo', offer: 'Starter offer (low-ticket, DIY)', min: 0 },
  { id: 'small', label: 'Small', range: '$5k–$25k/mo', offer: 'Growth offer (entry package)', min: 4 },
  { id: 'mid', label: 'Mid-size', range: '$25k–$100k/mo', offer: 'Core offer (done-for-you)', min: 7 },
  { id: 'large', label: 'Large', range: '$100k–$500k/mo', offer: 'Premium offer (monthly retainer)', min: 10 },
  { id: 'enterprise', label: 'Enterprise', range: '$500k+/mo', offer: 'Enterprise offer (custom scope)', min: 13 },
];

/** Tier id used for leads without an estimate (non-Shopify, errors, older saves). */
export const UNKNOWN_TIER = 'unknown';

/** Tier ids for filters, including "unknown". */
export const SIZE_ORDER = [...SIZE_TIERS.map((t) => t.id), UNKNOWN_TIER];

/** Display label for any tier id. */
export function tierLabel(id) {
  const t = SIZE_TIERS.find((x) => x.id === id);
  return t ? t.label : 'Unknown';
}

const APPS = [
  // [name, regex, group]
  ['Klaviyo', /klaviyo/i, 'email'],
  ['Omnisend', /omnisend/i, 'email'],
  ['Attentive', /attn\.tv|attentivemobile/i, 'premium'],
  ['Postscript', /postscript\.io/i, 'premium'],
  ['Yotpo', /yotpo/i, 'premium'],
  ['Okendo', /okendo/i, 'premium'],
  ['Gorgias', /gorgias/i, 'premium'],
  ['Rebuy', /rebuyengine/i, 'premium'],
  ['Recharge', /rechargecdn\.com|rechargeapps\.com|rechargepayments/i, 'premium'],
  ['Judge.me', /judge\.me|judgeme/i, 'reviews'],
  ['Loox', /loox\.io/i, 'reviews'],
  ['Stamped', /stamped\.io/i, 'reviews'],
  ['Meta pixel', /connect\.facebook\.net\/[^"'\s]*fbevents|fbq\(\s*['"]init/i, 'ads'],
  ['TikTok pixel', /analytics\.tiktok\.com|ttq\.load/i, 'ads'],
  ['Google Ads', /googleadservices|["'\s]AW-\d{6,}/i, 'ads'],
  ['Pinterest tag', /pintrk\(/i, 'ads'],
  ['Snap pixel', /sc-static\.net\/scevent/i, 'ads'],
  ['Klarna', /klarna/i, 'bnpl'],
  ['Afterpay', /afterpay/i, 'bnpl'],
  ['Affirm', /affirm\.com|affirm-js/i, 'bnpl'],
  ['Sezzle', /sezzle/i, 'bnpl'],
];

/**
 * Marketing and sales apps visible in the homepage source.
 *
 * @param {string} html
 * @returns {{ name: string, group: string }[]}
 */
export function detectApps(html) {
  const src = String(html || '');
  return APPS.filter(([, re]) => re.test(src)).map(([name, , group]) => ({ name, group }));
}

/**
 * Parse Shopify's public /meta.json.
 *
 * @param {string} text
 * @returns {{ productCount: number|null, countries: number|null, currency: string }|null}
 */
export function parseMeta(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const count = Number(j.published_products_count);
  return {
    productCount: Number.isFinite(count) ? count : null,
    countries: Array.isArray(j.ships_to_countries) ? j.ships_to_countries.length : null,
    currency: typeof j.currency === 'string' ? j.currency : '',
  };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Parse a page of Shopify's public /products.json.
 *
 * @param {string} text
 * @param {number} [now] Timestamp used for "recently updated" (tests pass a fixed value).
 * @returns {{ sampled: number, medianPrice: number|null, recentlyUpdated: number }|null}
 */
export function parseProducts(text, now = Date.now()) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.products)) return null;
  const prices = [];
  let recent = 0;
  const monthAgo = now - 30 * 24 * 3600 * 1000;
  for (const p of j.products) {
    const variantPrices = (p.variants || []).map((v) => parseFloat(v.price)).filter((n) => Number.isFinite(n) && n > 0);
    if (variantPrices.length) prices.push(Math.min(...variantPrices));
    const updated = Date.parse(p.updated_at || p.published_at || '');
    if (Number.isFinite(updated) && updated >= monthAgo) recent++;
  }
  const med = median(prices);
  return {
    sampled: j.products.length,
    medianPrice: med == null ? null : Math.round(med * 100) / 100,
    recentlyUpdated: recent,
  };
}

/**
 * @typedef {Object} SalesEstimate
 * @property {string} tier          Tier id (see SIZE_TIERS).
 * @property {string} label         e.g. "Mid-size".
 * @property {string} range         e.g. "$25k–$100k/mo".
 * @property {string} offer         Suggested offer level.
 * @property {number} score         Signal score behind the tier.
 * @property {'low'|'medium'} confidence
 * @property {number|null} productCount
 * @property {number|null} medianPrice
 * @property {string} currency
 * @property {number|null} countries
 * @property {string[]} apps        Detected app and pixel names.
 * @property {string[]} reasons     Short human-readable signals.
 */

/**
 * Combine the signals into a size tier.
 *
 * @param {Object} s
 * @param {{ name: string, group: string }[]} s.apps
 * @param {ReturnType<typeof parseMeta>} s.meta
 * @param {ReturnType<typeof parseProducts>} s.products
 * @param {number} [s.socialCount]
 * @returns {SalesEstimate}
 */
export function estimateSales({ apps = [], meta = null, products = null, socialCount = 0 }) {
  let score = 0;
  const reasons = [];

  const productCount = meta && meta.productCount != null ? meta.productCount : products ? products.sampled : null;
  const countIsLowerBound = !(meta && meta.productCount != null);
  if (productCount != null) {
    const pts = productCount >= 1000 ? 4 : productCount >= 200 ? 3 : productCount >= 50 ? 2 : productCount >= 10 ? 1 : 0;
    score += pts;
    reasons.push(`${productCount}${countIsLowerBound && products && products.sampled >= 250 ? '+' : ''} products`);
  }

  const medianPrice = products ? products.medianPrice : null;
  const currency = (meta && meta.currency) || '';
  if (medianPrice != null) {
    score += medianPrice >= 150 ? 2 : medianPrice >= 50 ? 1 : 0;
    reasons.push(`median price ${currency ? currency + ' ' : ''}${medianPrice}`);
  }

  if (products && products.recentlyUpdated >= 5) {
    score += 1;
    reasons.push(`${products.recentlyUpdated} products updated in the last 30 days`);
  }

  const groups = (g) => apps.filter((a) => a.group === g);
  const premium = groups('premium');
  if (premium.length) score += Math.min(premium.length, 4);
  if (groups('email').length) score += 1;
  if (groups('reviews').length) score += 1;
  const ads = groups('ads');
  if (ads.length) score += Math.min(ads.length, 2);
  if (groups('bnpl').length) score += 1;
  if (apps.length) reasons.push(apps.map((a) => a.name).join(', '));

  const countries = meta ? meta.countries : null;
  if (countries != null && countries > 1) {
    score += countries >= 50 ? 2 : countries >= 10 ? 1 : 0;
    reasons.push(`ships to ${countries} countries`);
  }

  if (socialCount >= 3) {
    score += 1;
    reasons.push(`${socialCount} social profiles`);
  }

  const tier = [...SIZE_TIERS].reverse().find((t) => score >= t.min);
  return {
    tier: tier.id,
    label: tier.label,
    range: tier.range,
    offer: tier.offer,
    score,
    confidence: meta || products ? 'medium' : 'low',
    productCount,
    medianPrice,
    currency,
    countries,
    apps: apps.map((a) => a.name),
    reasons,
  };
}

/** Tier id of a lead, or "unknown". */
export function leadTier(lead) {
  return (lead && lead.sales && lead.sales.tier) || UNKNOWN_TIER;
}
