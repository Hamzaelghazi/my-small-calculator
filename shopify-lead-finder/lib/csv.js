/**
 * CSV export for saved leads.
 */

import { leadBestPhone, leadPhoneDetails } from './scanner.js';
import { hostingLabel } from './dns.js';

export const CSV_COLUMNS = [
  'Store Name',
  'URL',
  'Shopify',
  'MyShopify Domain',
  'Best Email',
  'Best Email Tag',
  'Best Phone',
  'All Emails',
  'Phones',
  'WhatsApp',
  'Instagram',
  'Facebook',
  'TikTok',
  'LinkedIn',
  'X',
  'YouTube',
  'Pinterest',
  'Est. Monthly Sales',
  'Store Size',
  'Suggested Offer',
  'Products',
  'Median Price',
  'Tech Stack',
  'DNS Host',
  'Status',
  'First Scanned',
  'Scanned At',
];

/**
 * Human label for a scan status.
 *
 * @param {object} lead
 * @returns {string}
 */
export function statusLabel(lead) {
  if (lead.status === 'ok') return 'OK';
  if (lead.status === 'password_protected') return 'Store password protected';
  return lead.error ? `Error: ${lead.error}` : 'Error';
}

/**
 * Quote one cell. Also defuses spreadsheet formulas: a cell starting with
 * =, @, tab or CR (or + / - not followed by a digit) gets a leading apostrophe.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=@\t\r]/.test(s) || /^[+-](?!\d)/.test(s)) s = "'" + s;
  if (/[",\r\n;]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * One CSV row for a lead, in CSV_COLUMNS order.
 *
 * @param {object} lead
 * @returns {string[]}
 */
export function leadToRow(lead) {
  const emails = lead.emails || [];
  const best = emails.find((e) => e.email === lead.bestEmail);
  const s = lead.socials || {};
  const sales = lead.sales || null;
  return [
    lead.storeName || '',
    lead.url || lead.input || '',
    lead.isShopify ? 'yes' : 'no',
    lead.myshopifyDomain || '',
    lead.bestEmail || '',
    best ? best.tag : '',
    leadBestPhone(lead) || '',
    emails.map((e) => e.email).join('; '),
    leadPhoneDetails(lead).map((d) => d.phone).join('; '),
    lead.whatsapp || '',
    s.instagram || '',
    s.facebook || '',
    s.tiktok || '',
    s.linkedin || '',
    s.x || '',
    s.youtube || '',
    s.pinterest || '',
    sales ? `${sales.range} (estimate)` : '',
    sales ? sales.label : '',
    sales ? sales.offer : '',
    sales && sales.productCount != null ? sales.productCount : '',
    sales && sales.medianPrice != null ? `${sales.currency ? sales.currency + ' ' : ''}${sales.medianPrice}` : '',
    sales ? sales.apps.join('; ') : '',
    lead.hosting && lead.hosting.detected ? `${hostingLabel(lead.hosting)}: ${lead.hosting.evidence}` : '',
    statusLabel(lead),
    lead.firstScannedAt || lead.scannedAt || '',
    lead.scannedAt || '',
  ];
}

/**
 * Full CSV text (with header row, CRLF line endings, no BOM).
 *
 * @param {object[]} leads
 * @returns {string}
 */
export function leadsToCsv(leads) {
  const lines = [CSV_COLUMNS, ...leads.map(leadToRow)].map((row) => row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * "shopify-leads-YYYY-MM-DD.csv" in local time.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function csvFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `shopify-leads-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
}

/**
 * Download leads as a UTF-8 CSV (with BOM so Excel reads accents correctly).
 *
 * @param {object[]} leads
 */
export function downloadCsv(leads) {
  const blob = new Blob(['﻿' + leadsToCsv(leads)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFilename();
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
