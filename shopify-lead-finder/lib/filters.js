/**
 * Email tag filter shared by the dashboard tables and the CSV export.
 */

import { TAGS, TAG_ORDER, leadBestPhone } from './scanner.js';
import { SIZE_ORDER, leadTier } from './sales.js';
import { emailDomain } from './dns.js';

/** One-click tag selections. */
export const PRESETS = {
  all: TAG_ORDER,
  owner: [TAGS.OWNER, TAGS.STORE],
  outreach: [TAGS.OWNER, TAGS.STORE, TAGS.BUSINESS, TAGS.PERSONAL],
};

/**
 * True when at least one tag is switched off.
 *
 * @param {Set<string>} tags Selected tags.
 * @returns {boolean}
 */
export function isFilterActive(tags) {
  return TAG_ORDER.some((t) => !tags.has(t));
}

/**
 * Keep only the emails whose tag is selected and pick the best one again.
 * With no filter active the lead comes back unchanged. With a filter active,
 * a lead with no matching email returns null so callers can hide it.
 *
 * @param {object} lead A scan result or saved lead.
 * @param {Set<string>} tags Selected tags.
 * @returns {object|null}
 */
export function applyTagFilter(lead, tags) {
  if (!isFilterActive(tags)) return lead;
  const emails = (lead.emails || []).filter((e) => tags.has(e.tag));
  if (!emails.length) return null;
  const best = emails.find((e) => e.score >= 0);
  return { ...lead, emails, bestEmail: best ? best.email : null };
}

/**
 * True when at least one store size is switched off.
 *
 * @param {Set<string>} sizes Selected tier ids (see SIZE_ORDER).
 * @returns {boolean}
 */
export function isSizeFilterActive(sizes) {
  return SIZE_ORDER.some((t) => !sizes.has(t));
}

/**
 * ds.network email filter: keep only emails whose domain's mail is hosted on
 * ds.network, and attach the DNS evidence to each as `mail`. Extraction is
 * untouched; this only filters what was already found.
 *
 * @param {object} lead
 * @param {(domain: string) => (object|undefined)} mailCheck Result of isDsNetworkHosted() for a domain,
 *   or undefined if not looked up yet (treated as hidden until it is).
 * @returns {object|null} null when no email matches.
 */
export function applyMailFilter(lead, mailCheck) {
  const emails = (lead.emails || [])
    .map((e) => ({ ...e, mail: mailCheck(emailDomain(e.email)) }))
    .filter((e) => e.mail && e.mail.detected);
  if (!emails.length) return null;
  const best = emails.find((e) => e.score >= 0);
  return { ...lead, emails, bestEmail: best ? best.email : null };
}

/**
 * Apply the phone, store-size, email tag and (optional) ds.network filters.
 *
 * @param {object} lead
 * @param {{ tags: Set<string>, sizes: Set<string>, phoneOnly?: boolean, mailCheck?: Function|null }} f
 * @returns {object|null} null when the lead is filtered out.
 */
export function applyFilters(lead, { tags, sizes, phoneOnly = false, mailCheck = null }) {
  if (phoneOnly && !leadBestPhone(lead)) return null;
  if (isSizeFilterActive(sizes) && !sizes.has(leadTier(lead))) return null;
  const tagged = applyTagFilter(lead, tags);
  if (!tagged || !mailCheck) return tagged;
  return applyMailFilter(tagged, mailCheck);
}
