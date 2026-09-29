/**
 * "Have I scanned this store before?" lookups, built from saved leads and the
 * scan history. Pure functions so they can be tested in Node.
 */

import { normalizeInput } from './scanner.js';

/**
 * @typedef {Object} PreviousScan
 * @property {string}  firstScannedAt
 * @property {string}  lastScannedAt
 * @property {number}  count      Times scanned (at least 1).
 * @property {boolean} saved      Saved as a lead.
 * @property {string}  status     Last known status: ok, password_protected or error.
 * @property {boolean} isShopify
 * @property {string}  error
 */

function later(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function earlier(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Index every origin that was scanned or saved.
 *
 * @param {Record<string, object>} leads   Saved leads keyed by origin.
 * @param {Record<string, object>} history Scan history keyed by origin.
 * @returns {Map<string, PreviousScan>}
 */
export function buildScanIndex(leads = {}, history = {}) {
  const index = new Map();

  for (const [origin, h] of Object.entries(history)) {
    index.set(origin, {
      firstScannedAt: h.firstScannedAt || h.lastScannedAt || '',
      lastScannedAt: h.lastScannedAt || '',
      count: h.count || 1,
      saved: false,
      status: h.status || '',
      isShopify: !!h.isShopify,
      error: h.error || '',
    });
  }

  for (const lead of Object.values(leads)) {
    const keys = new Set([lead.url]);
    const n = normalizeInput(lead.input || '');
    if (n.ok) keys.add(n.origin);
    for (const key of keys) {
      if (!key) continue;
      const prev = index.get(key);
      const leadFirst = lead.firstScannedAt || lead.scannedAt || '';
      index.set(key, {
        firstScannedAt: earlier(prev && prev.firstScannedAt, leadFirst),
        lastScannedAt: later(prev && prev.lastScannedAt, lead.scannedAt || ''),
        count: prev ? prev.count : 1,
        saved: true,
        status: prev && prev.lastScannedAt > (lead.scannedAt || '') ? prev.status : lead.status,
        isShopify: !!lead.isShopify,
        error: prev ? prev.error : '',
      });
    }
  }
  return index;
}

/**
 * True when a store counts as already done: saved, or scanned without an
 * error. Failed scans don't count, so they are tried again.
 *
 * @param {PreviousScan|undefined} prev
 * @returns {boolean}
 */
export function isAlreadyScanned(prev) {
  return !!prev && (prev.saved || prev.status !== 'error');
}

/**
 * Short date like "Sep 29, 2026".
 *
 * @param {string} iso
 * @returns {string}
 */
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * One-line description, e.g. "Scanned Sep 29, 2026 · saved as a lead".
 *
 * @param {PreviousScan} prev
 * @returns {string}
 */
export function describePrevious(prev) {
  if (!prev) return '';
  const parts = [`Scanned ${formatDate(prev.lastScannedAt || prev.firstScannedAt)}`];
  if (prev.count > 1) parts.push(`${prev.count} times, first on ${formatDate(prev.firstScannedAt)}`);
  if (prev.saved) parts.push('saved as a lead');
  else if (prev.status === 'error') parts.push(`failed: ${prev.error || 'error'}`);
  else if (!prev.isShopify) parts.push('not saved (not Shopify)');
  else parts.push('not saved');
  return parts.join(' · ');
}
