/**
 * Email tag filter shared by the dashboard tables and the CSV export.
 */

import { TAGS, TAG_ORDER } from './scanner.js';
import { SIZE_ORDER, leadTier } from './sales.js';

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
 * Apply both the store-size filter and the email tag filter.
 *
 * @param {object} lead
 * @param {{ tags: Set<string>, sizes: Set<string> }} f
 * @returns {object|null} null when the lead is filtered out.
 */
export function applyFilters(lead, { tags, sizes }) {
  if (isSizeFilterActive(sizes) && !sizes.has(leadTier(lead))) return null;
  return applyTagFilter(lead, tags);
}
