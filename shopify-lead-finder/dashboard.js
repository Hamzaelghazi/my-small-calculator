import { scanStore, parseUrlList, extractUrlsFromText, rescoreLead, leadBestPhone, setMaxConnections, TAG_ORDER } from './lib/scanner.js';
import { PRESETS, isFilterActive, isSizeFilterActive, applyFilters } from './lib/filters.js';
import { SIZE_ORDER, SIZE_TIERS, tierLabel } from './lib/sales.js';
import {
  getLeads,
  saveLeads,
  deleteLead,
  clearLeads,
  onLeadsChanged,
  getHistory,
  recordScans,
  clearHistory,
  onHistoryChanged,
} from './lib/storage.js';
import { buildScanIndex, isAlreadyScanned, describePrevious, formatDate } from './lib/history.js';
import {
  isCrazyDomainsHosted,
  hostingLabel,
  getCrazyDomainsOnly,
  setCrazyDomainsOnly,
  checkEmailDomains,
  cachedDsResult,
  preloadDnsCache,
  dsLabel,
  getDsOnly,
  setDsOnly,
} from './lib/dns.js';
import { downloadCsv } from './lib/csv.js';
import { h, copyText, copyButton, toast, tagBadge, socialLinks, safeHref, displayHost } from './lib/ui.js';

const $ = (id) => document.getElementById(id);

let controller = null;
let savedLeads = {};
/** Results of the current bulk run, so the table can re-render when the filter changes. */
let runResults = [];
/** How many of runResults pass the email filter (kept incrementally for big runs). */
let shownResults = 0;
/** Origins that failed in the last run, for "Retry failed". */
let failedOrigins = [];

/** Saved-leads rows rendered at once. Search narrows it; export and copy always use every match. */
const SAVED_ROW_LIMIT = 300;
const DRAFT_KEY = 'slf.urlDraft';

/* -------------------------------------------------------------------------- */
/* Batched saving                                                             */
/* -------------------------------------------------------------------------- */

// Saving each result on its own rewrites the whole leads object every time,
// which gets slow with hundreds of leads. Results are queued and written in
// one batch every FLUSH_MS instead.
const FLUSH_MS = 1500;
let pendingSaves = [];
let flushTimer = null;
let flushing = Promise.resolve();

/** Queue a finished scan: it's added to the scan history, and saved as a lead if marked "saved". */
function queueSave(entry) {
  pendingSaves.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flushSaves, FLUSH_MS);
}

function flushSaves() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const batch = pendingSaves;
  pendingSaves = [];
  if (!batch.length) return flushing;
  flushing = flushing.then(async () => {
    const toSave = batch.filter((e) => e.saveState === 'saved');
    try {
      if (toSave.length) await saveLeads(toSave.map((e) => e.res));
    } catch {
      for (const e of toSave) e.saveState = 'save-failed';
      toast(`Couldn't save ${toSave.length} lead${toSave.length === 1 ? '' : 's'}`);
      renderResults();
    }
    try {
      await recordScans(batch.map((e) => ({ result: e.res, origin: e.origin })));
    } catch {
      /* history is a convenience */
    }
  });
  return flushing;
}

/* -------------------------------------------------------------------------- */
/* Scan history index                                                         */
/* -------------------------------------------------------------------------- */

let scanHistory = {};
/** origin → previous scan, from saved leads + scan history. */
let scanIndex = new Map();

function rebuildIndex() {
  scanIndex = buildScanIndex(savedLeads, scanHistory);
}

/* -------------------------------------------------------------------------- */
/* Email tag filter                                                           */
/* -------------------------------------------------------------------------- */

const FILTER_KEY = 'slf.tagFilter';

function loadTagFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
    if (Array.isArray(saved)) return new Set(saved.filter((t) => TAG_ORDER.includes(t)));
  } catch {
    /* storage unavailable */
  }
  return new Set(TAG_ORDER);
}

let tagFilter = loadTagFilter();

const SIZE_KEY = 'slf.sizeFilter';

function loadSizeFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    if (Array.isArray(saved)) return new Set(saved.filter((t) => SIZE_ORDER.includes(t)));
  } catch {
    /* storage unavailable */
  }
  return new Set(SIZE_ORDER);
}

let sizeFilter = loadSizeFilter();

const PHONE_KEY = 'slf.phoneOnly';
let phoneOnly = false;
try {
  phoneOnly = localStorage.getItem(PHONE_KEY) === '1';
} catch {
  /* storage unavailable */
}

function setPhoneOnly(on) {
  phoneOnly = on;
  try {
    localStorage.setItem(PHONE_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  renderFilterBar();
  renderResults();
  renderSaved();
}

/** Current filters, as passed to applyFilters(). */
/* ds.network email filter: a layer over the extracted emails, nothing is re-scanned. */
let dsOnly = false;
/** Email domains still being looked up, for the status note. */
let dsPending = 0;

/** Look up the mail servers of every email domain on screen, re-rendering as answers arrive. */
async function checkVisibleEmailDomains() {
  if (!dsOnly) return;
  const leads = [...Object.values(savedLeads), ...runResults.map((r) => r.res)];
  const domains = new Set(leads.flatMap((l) => (l.emails || []).map((e) => e.email.split('@').pop())));
  dsPending = [...domains].filter((d) => !cachedDsResult(d)).length;
  renderFilterBar();
  await checkEmailDomains(leads, {
    onResult: () => {
      dsPending = Math.max(0, dsPending - 1);
      scheduleFilterRender();
    },
  });
  dsPending = 0;
  scheduleFilterRender();
}

let filterRenderTimer;
function scheduleFilterRender() {
  clearTimeout(filterRenderTimer);
  filterRenderTimer = setTimeout(() => {
    renderFilterBar();
    renderResults();
    renderSaved();
  }, 250);
}

async function setDsFilter(on) {
  dsOnly = on;
  await setDsOnly(on);
  renderFilterBar();
  renderResults();
  renderSaved();
  checkVisibleEmailDomains();
}

function filters() {
  return { tags: tagFilter, sizes: sizeFilter, phoneOnly, mailCheck: dsOnly ? cachedDsResult : null };
}

function anyFilterActive() {
  return dsOnly || phoneOnly || isFilterActive(tagFilter) || isSizeFilterActive(sizeFilter);
}

function setSizeFilter(sizes) {
  sizeFilter = new Set(sizes);
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify([...sizeFilter]));
  } catch {
    /* storage unavailable */
  }
  renderFilterBar();
  renderResults();
  renderSaved();
}

function setTagFilter(tags) {
  tagFilter = new Set(tags);
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify([...tagFilter]));
  } catch {
    /* storage unavailable */
  }
  renderFilterBar();
  renderResults();
  renderSaved();
}

function sameSet(a, list) {
  return a.size === list.length && list.every((t) => a.has(t));
}

function renderFilterBar() {
  const chips = TAG_ORDER.map((tag) => {
    const on = tagFilter.has(tag);
    const chip = h(
      'button',
      { type: 'button', class: `chip${tag === 'likely owner' ? ' chip-owner' : ''}`, 'aria-pressed': String(on) },
      h('span', { class: 'chip-check', 'aria-hidden': 'true', text: on ? '✓' : '' }),
      tag
    );
    chip.addEventListener('click', () => {
      const next = new Set(tagFilter);
      if (on) next.delete(tag);
      else next.add(tag);
      setTagFilter(next);
    });
    return chip;
  });
  const preset = (label, list) => {
    const btn = h('button', {
      type: 'button',
      class: 'btn btn-small btn-ghost preset',
      'aria-pressed': String(sameSet(tagFilter, list)),
      text: label,
    });
    btn.addEventListener('click', () => setTagFilter(list));
    return btn;
  };
  $('tagChips').replaceChildren(...chips);
  $('presets').replaceChildren(
    preset('All emails', PRESETS.all),
    preset('Owner-focused', PRESETS.owner),
    preset('Outreach-ready', PRESETS.outreach)
  );
  const sizeChips = SIZE_ORDER.map((id) => {
    const on = sizeFilter.has(id);
    const tier = SIZE_TIERS.find((t) => t.id === id);
    const chip = h(
      'button',
      {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(on),
        title: tier ? `${tier.range} (estimate) · ${tier.offer}` : 'No estimate (not Shopify, failed, or saved before this feature)',
      },
      h('span', { class: 'chip-check', 'aria-hidden': 'true', text: on ? '✓' : '' }),
      tierLabel(id),
      tier ? h('span', { class: 'chip-sub', text: tier.range.replace('/mo', '') }) : null
    );
    chip.addEventListener('click', () => {
      const next = new Set(sizeFilter);
      if (on) next.delete(id);
      else next.add(id);
      setSizeFilter(next);
    });
    return chip;
  });
  $('sizeChips').replaceChildren(...sizeChips);
  const allSizes = h('button', {
    type: 'button',
    class: 'btn btn-small btn-ghost preset',
    'aria-pressed': String(!isSizeFilterActive(sizeFilter)),
    text: 'All sizes',
  });
  allSizes.addEventListener('click', () => setSizeFilter(SIZE_ORDER));
  $('sizePresets').replaceChildren(allSizes);

  const phoneChip = h(
    'button',
    { type: 'button', class: 'chip', 'aria-pressed': String(phoneOnly), title: 'Only stores with a phone number, for cold calling' },
    h('span', { class: 'chip-check', 'aria-hidden': 'true', text: phoneOnly ? '✓' : '' }),
    'Has phone number'
  );
  phoneChip.addEventListener('click', () => setPhoneOnly(!phoneOnly));
  const dsChip = h(
    'button',
    {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(dsOnly),
      title: 'Checks the MX records of each email’s domain and keeps only those on ds.network mail (rc.ds.network)',
    },
    h('span', { class: 'chip-check', 'aria-hidden': 'true', text: dsOnly ? '✓' : '' }),
    'Only show emails hosted on ds.network (rc.ds.network)',
    dsOnly && dsPending ? h('span', { class: 'chip-sub', text: `checking ${dsPending} domain${dsPending === 1 ? '' : 's'}…` }) : null
  );
  dsChip.addEventListener('click', () => setDsFilter(!dsOnly));
  $('contactChips').replaceChildren(phoneChip, dsChip);

  $('filterNote').textContent = anyFilterActive()
    ? 'Stores that don’t match are hidden. Best email, copy and CSV export use only what’s selected.'
    : 'Showing everything. Switch tags or sizes off to narrow the tables and the CSV export.';
}

/* -------------------------------------------------------------------------- */
/* URL input                                                                  */
/* -------------------------------------------------------------------------- */

function updateUrlCount() {
  const { origins, invalid, duplicates } = parseUrlList($('urls').value);
  const parts = [];
  if (!origins.length && !invalid.length) {
    $('urlCount').textContent = 'No URLs yet';
    return;
  }
  parts.push(`${origins.length} valid URL${origins.length === 1 ? '' : 's'}`);
  if (duplicates) parts.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} removed`);
  if (invalid.length) parts.push(`${invalid.length} invalid (${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''})`);
  const seen = origins.filter((o) => isAlreadyScanned(scanIndex.get(o))).length;
  if (seen) parts.push(`${seen} already scanned${$('skipSaved').checked ? ' (will be skipped)' : ' (will be scanned again)'}`);
  $('urlCount').textContent = parts.join(' · ');
}

/**
 * Requests on the network at once, across all stores. "All at once" starts
 * every store immediately; this cap keeps Chrome responsive and keeps stores
 * (most share Shopify's servers) from rate-limiting you.
 */
const MAX_CONNECTIONS = 60;
setMaxConnections(MAX_CONNECTIONS);

/** Stores scanned in parallel. "all" = every store in the list at once. */
function concurrency() {
  const el = document.querySelector('input[name="concurrency"]:checked');
  if (!el) return 10;
  return el.value === 'all' ? Infinity : Number(el.value);
}

/* -------------------------------------------------------------------------- */
/* Worker pool                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run `worker` over `items` with at most `size` in flight. Each worker pulls
 * the next item when it finishes, so one slow store never holds up the rest.
 *
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @param {(item: T) => Promise<void>} worker
 * @param {AbortSignal} signal
 */
async function runPool(items, size, worker, signal) {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !signal.aborted) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
}

/* -------------------------------------------------------------------------- */
/* Results table                                                              */
/* -------------------------------------------------------------------------- */

/** "Est. sales" cell: monthly range plus tier, with the offer and signals on hover. */
function salesCell(lead) {
  const est = lead.sales;
  if (!est) return h('span', { class: 'muted', text: '—' });
  return h(
    'span',
    {
      class: 'sales-cell',
      title: `${est.label}: ${est.range} (rough estimate, ${est.confidence} confidence)\nSuggested offer: ${est.offer}${
        est.reasons.length ? `\nSignals: ${est.reasons.join(' · ')}` : ''
      }`,
    },
    h('span', { class: 'sales-range', text: est.range.replace('/mo', '') }),
    h('span', { class: 'sales-tier', text: est.label })
  );
}

function bestEmailCell(lead, { withTag = true } = {}) {
  if (!lead.bestEmail) return h('span', { class: 'muted', text: 'No public email' });
  const best = lead.emails.find((e) => e.email === lead.bestEmail);
  const btn = h(
    'button',
    { type: 'button', class: 'email-copy', title: 'Click to copy', 'aria-label': `Copy ${lead.bestEmail}` },
    h('span', { text: lead.bestEmail }),
    withTag && best ? tagBadge(best.tag) : null,
    best && best.mail && best.mail.detected
      ? h('span', { class: 'badge badge-hosting', text: dsLabel(best.mail), title: `Mail server: ${best.mail.evidence}` })
      : null
  );
  btn.addEventListener('click', async () => {
    toast((await copyText(lead.bestEmail)) ? `Copied ${lead.bestEmail}` : 'Copy failed');
  });
  return btn;
}

function statusCell(res, saveState, previous) {
  const before = previous
    ? h('small', { class: 'status-prev', text: `Scanned before on ${formatDate(previous.lastScannedAt)}`, title: describePrevious(previous) })
    : null;
  if (res.status === 'error') {
    return h('span', { class: 'status status-error' }, res.error || 'Error', before);
  }
  const label = {
    saved: res.status === 'password_protected' ? 'Password protected · saved' : 'Saved',
    'not-shopify': 'Not saved (not Shopify)',
    'save-failed': 'Scanned, save failed',
  }[saveState];
  const cls = saveState === 'saved' ? 'status-ok' : saveState === 'save-failed' ? 'status-error' : 'status-muted';
  return h('span', { class: `status ${cls}` }, label, before);
}

/** "Crazy Domains (NS)" / "(MX)" badge, or null when the store didn't match. */
function hostingBadgeEl(lead) {
  const label = hostingLabel(lead.hosting);
  if (!label) return null;
  return h('span', {
    class: 'badge badge-hosting cell-badge',
    text: label,
    title: `Matched ${lead.hosting.type === 'mx' ? 'mail server' : 'nameserver'}: ${lead.hosting.evidence}`,
  });
}

/** Best phone as a click-to-call link. */
function phoneCell(lead) {
  const phone = leadBestPhone(lead);
  if (!phone) return h('span', { class: 'muted', text: '—' });
  return h('a', { class: 'phone-link', href: `tel:${phone}`, text: phone, title: 'Call' });
}

function detailRow(res, colSpan) {
  return h(
    'tr',
    { class: 'detail-row', hidden: true },
    h(
      'td',
      { colspan: colSpan },
      h(
        'ul',
        { class: 'detail-list' },
        res.emails.map((e) =>
          h(
            'li',
            {},
            h('span', { class: 'addr', text: e.email, title: `Found on ${e.sources.join(', ')}` }),
            tagBadge(e.tag),
            h('span', { class: 'score', text: `Score ${e.score}` }),
            e.mail && e.mail.detected ? h('span', { class: 'score', text: `${dsLabel(e.mail)}: ${e.mail.evidence}` }) : null,
            copyButton(e.email)
          )
        )
      )
    )
  );
}

function resultRows({ res: orig, saveState, previous }) {
  const res = applyFilters(orig, filters());
  if (!res) return [];
  const others = res.emails.filter((e) => e.email !== res.bestEmail).length;
  const detail = res.emails.length ? detailRow(res, 9) : null;
  let expand = h('span', { class: 'muted', text: '0' });
  if (detail) {
    expand = h('button', {
      type: 'button',
      class: 'btn btn-small expand',
      'aria-expanded': 'false',
      'aria-label': `Show all ${res.emails.length} emails for ${displayHost(res.url || res.input)}`,
      text: others ? `+${others}` : 'All',
    });
    expand.addEventListener('click', () => {
      const open = expand.getAttribute('aria-expanded') === 'true';
      expand.setAttribute('aria-expanded', String(!open));
      detail.hidden = open;
    });
  }

  const href = safeHref(res.url);
  const row = h(
    'tr',
    { class: 'row-new' },
    h('td', { class: 'cell-store' }, res.storeName || displayHost(res.url || res.input) || res.input, hostingBadgeEl(res)),
    h(
      'td',
      { class: 'cell-url' },
      href
        ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: displayHost(href) })
        : h('span', { class: 'muted', text: res.input })
    ),
    h(
      'td',
      {},
      res.status === 'error'
        ? h('span', { class: 'muted', text: '—' })
        : h('span', { class: `badge ${res.isShopify ? 'badge-shopify' : ''}`, text: res.isShopify ? 'Yes' : 'No' })
    ),
    h('td', {}, bestEmailCell(res)),
    h('td', {}, expand),
    h('td', { class: 'nowrap' }, phoneCell(res)),
    h('td', {}, salesCell(res)),
    h('td', {}, socialLinks(res.socials) || h('span', { class: 'muted', text: '—' })),
    h('td', {}, statusCell(res, saveState, previous))
  );
  return detail ? [row, detail] : [row];
}

function renderHiddenNote(el, hidden, noun) {
  el.textContent = hidden ? `${hidden} ${noun}${hidden === 1 ? '' : 's'} hidden by the filter` : '';
  el.hidden = !hidden;
}

/** Re-render the whole results table (after a filter change). */
function renderResults() {
  const rows = runResults.flatMap((entry) => resultRows(entry));
  rows.forEach((r) => r.classList.remove('row-new'));
  $('resultsBody').replaceChildren(...rows);
  shownResults = runResults.filter(({ res }) => applyFilters(res, filters())).length;
  $('resultsWrap').hidden = shownResults === 0;
  renderHiddenNote($('resultsHidden'), runResults.length - shownResults, 'store');
}

/** Add one finished store to the results table. */
function addResult(entry) {
  runResults.push(entry);
  const rows = resultRows(entry);
  $('resultsBody').append(...rows);
  if (rows.length) {
    shownResults++;
    $('resultsWrap').hidden = false;
  }
  renderHiddenNote($('resultsHidden'), runResults.length - shownResults, 'store');
}

/* -------------------------------------------------------------------------- */
/* Bulk run                                                                   */
/* -------------------------------------------------------------------------- */

function setRunning(running) {
  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
  $('urls').disabled = running;
  $('retryBtn').disabled = running;
  document.querySelectorAll('input[name="concurrency"], #shopifyOnly, #skipSaved, #cdOnly, #quickScan, #loadFileBtn').forEach((el) => {
    el.disabled = running;
  });
  $('startBtn').textContent = running ? 'Scanning…' : 'Start scan';
}

function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function renderProgress(stats, active) {
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  $('barFill').style.width = `${pct}%`;
  $('bar').setAttribute('aria-valuenow', String(pct));
  let text = `${stats.done} of ${stats.total} scanned, ${stats.emails} email${stats.emails === 1 ? '' : 's'} found`;
  if (stats.failed) text += ` · ${stats.failed} failed`;
  if (stats.skipped) text += ` · ${stats.skipped} skipped (already scanned)`;
  if (stats.notCd) text += ` · ${stats.notCd} not on Crazy Domains`;
  if (stats.dnsFailed) text += ` · ${stats.dnsFailed} DNS check failed`;
  $('progressText').textContent = text;

  let side = '';
  if (active && active.size) {
    const hosts = [...active].map(displayHost);
    side = `Scanning ${hosts.slice(0, 3).join(', ')}${hosts.length > 3 ? ` +${hosts.length - 3} more` : ''}`;
    // Estimate after a few stores so the first slow ones don't skew it.
    if (stats.done >= Math.max(5, stats.total * 0.02) && stats.done < stats.total) {
      const perStore = (Date.now() - stats.startedAt) / stats.done;
      const left = formatDuration(perStore * (stats.total - stats.done));
      side += left === 'under a minute' ? ' · under a minute left' : ` · about ${left} left`;
    }
  }
  $('activeText').textContent = side;
}

function renderRetry() {
  const btn = $('retryBtn');
  btn.hidden = failedOrigins.length === 0;
  btn.textContent = `Retry failed (${failedOrigins.length})`;
}

/** List the stores skipped because they were already scanned, with dates. */
function renderSkipped(list) {
  const box = $('skipped');
  box.hidden = !list.length;
  if (!list.length) return;
  const LIMIT = 500;
  $('skippedSummary').textContent = `${list.length} store${list.length === 1 ? '' : 's'} skipped: already scanned`;
  $('skippedList').replaceChildren(
    ...list.slice(0, LIMIT).map(({ origin, prev }) =>
      h('li', {}, h('span', { class: 'skipped-host', text: displayHost(origin) }), h('span', { class: 'muted', text: describePrevious(prev) }))
    ),
    ...(list.length > LIMIT ? [h('li', { class: 'muted', text: `…and ${list.length - LIMIT} more` })] : [])
  );
}

/** Errors worth a second try (not "not found" or "not a web page"). */
function isRetryable(res) {
  return res.status === 'error' && !/not found|not a web page|invalid url/i.test(res.error || '');
}

/**
 * Scan a list of stores with a worker pool.
 *
 * @param {string[]} [retryList] Origins to retry; defaults to the URL box.
 */
async function start(retryList) {
  const origins = Array.isArray(retryList) ? retryList : parseUrlList($('urls').value).origins;
  if (!origins.length) {
    toast('Paste at least one store URL');
    $('urls').focus();
    return;
  }

  // Fresh lookup, in case another tab or the popup scanned something meanwhile.
  [savedLeads, scanHistory] = await Promise.all([getLeads(), getHistory()]);
  rebuildIndex();
  let queue = origins;
  const skippedList = [];
  if ($('skipSaved').checked) {
    queue = [];
    for (const o of origins) {
      const prev = scanIndex.get(o);
      if (isAlreadyScanned(prev)) skippedList.push({ origin: o, prev });
      else queue.push(o);
    }
  }
  const skipped = skippedList.length;
  renderSkipped(skippedList);

  $('run').hidden = false;
  runResults = [];
  shownResults = 0;
  failedOrigins = [];
  renderRetry();
  $('resultsBody').replaceChildren();
  $('resultsWrap').hidden = true;
  renderHiddenNote($('resultsHidden'), 0, 'store');

  const stats = { total: queue.length, done: 0, emails: 0, failed: 0, skipped, notCd: 0, dnsFailed: 0, startedAt: Date.now() };
  const active = new Set();
  renderProgress(stats, active);

  if (!queue.length) {
    $('progressText').textContent = `All ${skipped} store${skipped === 1 ? ' was' : 's were'} already scanned. Uncheck “Skip stores already scanned” to scan again.`;
    return;
  }

  controller = new AbortController();
  const { signal } = controller;
  const shopifyOnly = $('shopifyOnly').checked;
  const cdOnly = $('cdOnly').checked;
  const quick = $('quickScan').checked;
  setRunning(true);

  await runPool(
    queue,
    concurrency(),
    async (url) => {
      active.add(url);
      renderProgress(stats, active);

      // Crazy Domains filter: check DNS before the (much heavier) page scan.
      // Non-matching stores and failed DNS lookups are skipped, not shown or
      // saved, and the run carries on with the next store.
      let hosting = null;
      if (cdOnly) {
        hosting = await isCrazyDomainsHosted(url, { signal });
        if (signal.aborted) return;
        if (!hosting.detected) {
          active.delete(url);
          if (hosting.error) stats.dnsFailed++;
          else stats.notCd++;
          stats.done++;
          renderProgress(stats, active);
          return;
        }
      }

      const res = await scanStore(url, { signal, quick });
      active.delete(url);
      if (signal.aborted) return; // stopped mid-scan: drop the partial result
      if (hosting) res.hosting = hosting;
      // With the ds.network filter on, look up this store's email domains before
      // its row is drawn, so it appears already filtered.
      if (dsOnly && res.emails.length) await checkEmailDomains([res], { signal });

      const previous = scanIndex.get(url) || scanIndex.get(res.url);
      const entry = { res, saveState: 'error', origin: url, previous };
      if (res.status === 'error') {
        stats.failed++;
        if (isRetryable(res)) failedOrigins.push(res.url || url);
      } else if (shopifyOnly && !res.isShopify) {
        entry.saveState = 'not-shopify';
      } else {
        entry.saveState = 'saved';
      }
      queueSave(entry);
      stats.done++;
      stats.emails += res.emails.length;
      addResult(entry);
      renderProgress(stats, active);
    },
    signal
  );

  await flushSaves();
  const wasStopped = signal.aborted;
  controller = null;
  setRunning(false);
  renderProgress(stats, null);
  renderRetry();
  const took = formatDuration(Date.now() - stats.startedAt);
  if (wasStopped) {
    $('progressText').textContent += ' · Stopped';
  } else {
    $('activeText').textContent = `Finished in ${took}`;
    toast(`Done: ${stats.done} store${stats.done === 1 ? '' : 's'} scanned`);
  }
}

function stop() {
  if (controller) controller.abort();
  $('stopBtn').disabled = true;
  $('activeText').textContent = 'Stopping…';
}

/* -------------------------------------------------------------------------- */
/* Saved leads                                                                */
/* -------------------------------------------------------------------------- */

function leadMatches(lead, q) {
  if (!q) return true;
  const hay = [lead.storeName, lead.url, lead.input, lead.myshopifyDomain, ...(lead.emails || []).map((e) => e.email)]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Saved leads after search and tag filter, newest first. */
function visibleLeads() {
  const q = $('search').value.trim();
  return Object.values(savedLeads)
    .filter((l) => leadMatches(l, q))
    .map((l) => applyFilters(rescoreLead(l), filters()))
    .filter(Boolean)
    .sort((a, b) => String(b.savedAt || b.scannedAt).localeCompare(String(a.savedAt || a.scannedAt)));
}

function savedRow(lead) {
  const best = (lead.emails || []).find((e) => e.email === lead.bestEmail);
  const href = safeHref(lead.url);
  const name = lead.storeName || displayHost(lead.url);
  const del = h('button', {
    type: 'button',
    class: 'btn btn-small btn-danger',
    text: 'Delete',
    'aria-label': `Delete ${name}`,
  });
  del.addEventListener('click', async () => {
    await deleteLead(lead.url);
    toast(`Deleted ${name}`);
  });

  const scanned = lead.scannedAt ? new Date(lead.scannedAt) : null;
  return h(
    'tr',
    {},
    h(
      'td',
      { class: 'cell-store' },
      name,
      hostingBadgeEl(lead),
      href
        ? h('small', {}, h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: displayHost(href) }))
        : null
    ),
    h('td', {}, bestEmailCell(lead, { withTag: false })),
    h('td', {}, best ? tagBadge(best.tag) : h('span', { class: 'muted', text: '—' })),
    h('td', { title: (lead.emails || []).map((e) => e.email).join('\n') }, String((lead.emails || []).length)),
    h('td', {}, salesCell(lead)),
    h('td', { class: 'nowrap' }, phoneCell(lead)),
    h('td', {}, socialLinks(lead.socials) || h('span', { class: 'muted', text: '—' })),
    h(
      'td',
      {
        class: 'nowrap muted',
        title: scanned
          ? `Last scanned ${scanned.toLocaleString()}${lead.firstScannedAt ? `\nFirst found ${new Date(lead.firstScannedAt).toLocaleString()}` : ''}`
          : '',
      },
      scanned ? formatDate(lead.scannedAt) : '—'
    ),
    h('td', {}, del)
  );
}

function renderSaved() {
  const all = Object.keys(savedLeads).length;
  const rows = visibleLeads();
  $('savedCount').textContent = String(all);
  $('savedCountTop').textContent = `${all} saved lead${all === 1 ? '' : 's'}`;
  $('savedBody').replaceChildren(...rows.slice(0, SAVED_ROW_LIMIT).map(savedRow));
  const more = rows.length - SAVED_ROW_LIMIT;
  $('savedMore').hidden = more <= 0;
  $('savedMore').textContent =
    more > 0
      ? `Showing the newest ${SAVED_ROW_LIMIT} of ${rows.length}. Search to narrow the list. Export CSV and Copy all best emails include all ${rows.length}.`
      : '';

  const empty = $('savedEmpty');
  if (!all) {
    empty.querySelector('h3').textContent = 'No saved leads yet';
    empty.querySelector('p').textContent = 'Scan a list above, or open a store and click “Save lead” in the extension popup.';
  } else if (!rows.length) {
    empty.querySelector('h3').textContent = 'No matches';
    empty.querySelector('p').textContent = anyFilterActive()
      ? 'No saved lead matches the selected email tags and store sizes. Switch more on in the filter.'
      : 'Try a different name, domain or email.';
  }
  empty.hidden = rows.length > 0;
  $('savedWrap').hidden = rows.length === 0;

  const q = $('search').value.trim();
  const searched = Object.values(savedLeads).filter((l) => leadMatches(l, q)).length;
  renderHiddenNote($('savedHidden'), searched - rows.length, 'lead');
  const filtered = rows.length !== all || anyFilterActive();
  $('exportBtn').textContent = filtered ? `Export CSV (${rows.length})` : 'Export CSV';
  $('exportBtn').disabled = !rows.length;
  $('copyAllBtn').disabled = !rows.some((l) => l.bestEmail);
  $('clearBtn').disabled = !all;
}

let renderTimer;
function scheduleRenderSaved() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderSaved, 120);
}

async function copyAllBest() {
  const emails = [...new Set(visibleLeads().map((l) => l.bestEmail).filter(Boolean))];
  if (!emails.length) return;
  const ok = await copyText(emails.join('\n'));
  toast(ok ? `Copied ${emails.length} email${emails.length === 1 ? '' : 's'}` : 'Copy failed');
}

async function clearAll() {
  const n = Object.keys(savedLeads).length;
  if (!n) return;
  if (!confirm(`Delete all ${n} saved lead${n === 1 ? '' : 's'}? This can’t be undone. Export a CSV first if you need them.`)) return;
  await clearLeads();
  toast('All saved leads deleted');
}

/* -------------------------------------------------------------------------- */
/* Init                                                                       */
/* -------------------------------------------------------------------------- */

async function init() {
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft && !$('urls').value) $('urls').value = draft;
  } catch {
    /* storage unavailable */
  }
  let draftTimer;
  $('urls').addEventListener('input', () => {
    updateUrlCount();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, $('urls').value);
      } catch {
        /* too big or unavailable: not critical */
      }
    }, 400);
  });
  $('retryBtn').addEventListener('click', () => start([...failedOrigins]));
  window.addEventListener('pagehide', () => flushSaves());
  window.addEventListener('beforeunload', (e) => {
    if (controller) e.preventDefault();
  });
  $('startBtn').addEventListener('click', () => start());

  // Load a .txt or .csv list of stores into the URL box (any cell that looks like a domain counts).
  $('loadFileBtn').addEventListener('click', () => $('urlFile').click());
  $('urlFile').addEventListener('change', async () => {
    const file = $('urlFile').files[0];
    $('urlFile').value = '';
    if (!file) return;
    const text = extractUrlsFromText(await file.text());
    const box = $('urls');
    box.value = box.value.trim() ? `${box.value.trim()}\n${text}` : text;
    box.dispatchEvent(new Event('input'));
    const { origins } = parseUrlList(text);
    toast(`Loaded ${origins.length} store URL${origins.length === 1 ? '' : 's'} from ${file.name}`);
  });

  // Remember speed and Quick scan between visits.
  try {
    const savedSpeed = localStorage.getItem('slf.speed');
    const radio = savedSpeed && document.querySelector(`input[name="concurrency"][value="${savedSpeed}"]`);
    if (radio) radio.checked = true;
    $('quickScan').checked = localStorage.getItem('slf.quick') === '1';
  } catch {
    /* storage unavailable */
  }
  document.querySelectorAll('input[name="concurrency"]').forEach((r) =>
    r.addEventListener('change', () => {
      try {
        localStorage.setItem('slf.speed', r.value);
      } catch {
        /* ignore */
      }
    })
  );
  $('quickScan').addEventListener('change', () => {
    try {
      localStorage.setItem('slf.quick', $('quickScan').checked ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  // Shared with the popup through chrome.storage.local.
  $('cdOnly').checked = await getCrazyDomainsOnly();
  $('cdOnly').addEventListener('change', () => setCrazyDomainsOnly($('cdOnly').checked));
  $('stopBtn').addEventListener('click', stop);
  $('search').addEventListener('input', scheduleRenderSaved);
  $('exportBtn').addEventListener('click', () => {
    const rows = visibleLeads();
    if (rows.length) downloadCsv(rows);
  });
  $('copyAllBtn').addEventListener('click', copyAllBest);
  $('clearBtn').addEventListener('click', clearAll);
  $('urls').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('startBtn').disabled) start();
  });

  onHistoryChanged((history) => {
    scanHistory = history;
    rebuildIndex();
    updateUrlCount();
  });
  $('skipSaved').addEventListener('change', updateUrlCount);
  $('clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Forget which stores were scanned? Saved leads are kept, and stores saved as leads still count as scanned.')) return;
    await clearHistory();
    toast('Scan history cleared');
  });
  onLeadsChanged((leads) => {
    savedLeads = leads;
    rebuildIndex();
    scheduleRenderSaved();
  });
  // The popup can flip the shared ds.network toggle while this tab is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.onlyDsNetworkEmails && !!changes.onlyDsNetworkEmails.newValue !== dsOnly) {
      setDsFilter(!!changes.onlyDsNetworkEmails.newValue);
    }
  });
  [savedLeads, scanHistory] = await Promise.all([getLeads(), getHistory()]);
  rebuildIndex();
  await preloadDnsCache();
  dsOnly = await getDsOnly();
  renderFilterBar();
  renderSaved();
  updateUrlCount();
  checkVisibleEmailDomains();
}

init();
