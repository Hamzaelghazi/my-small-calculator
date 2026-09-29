import { scanStore, parseUrlList, normalizeInput, rescoreLead, TAG_ORDER } from './lib/scanner.js';
import { PRESETS, isFilterActive, applyTagFilter } from './lib/filters.js';
import { getLeads, saveLead, deleteLead, clearLeads, onLeadsChanged } from './lib/storage.js';
import { downloadCsv } from './lib/csv.js';
import { h, copyText, copyButton, toast, tagBadge, socialLinks, safeHref, displayHost } from './lib/ui.js';

const $ = (id) => document.getElementById(id);

let controller = null;
let savedLeads = {};
/** Results of the current bulk run, so the table can re-render when the filter changes. */
let runResults = [];

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
  $('filterNote').textContent = isFilterActive(tagFilter)
    ? 'Stores without a matching email are hidden. Best email, copy and CSV export use only the selected tags.'
    : 'Showing every email. Switch tags off to narrow the tables and the CSV export.';
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
  $('urlCount').textContent = parts.join(' · ');
}

function concurrency() {
  const el = document.querySelector('input[name="concurrency"]:checked');
  return el ? Number(el.value) : 4;
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

function bestEmailCell(lead, { withTag = true } = {}) {
  if (!lead.bestEmail) return h('span', { class: 'muted', text: 'No public email' });
  const best = lead.emails.find((e) => e.email === lead.bestEmail);
  const btn = h(
    'button',
    { type: 'button', class: 'email-copy', title: 'Click to copy', 'aria-label': `Copy ${lead.bestEmail}` },
    h('span', { text: lead.bestEmail }),
    withTag && best ? tagBadge(best.tag) : null
  );
  btn.addEventListener('click', async () => {
    toast((await copyText(lead.bestEmail)) ? `Copied ${lead.bestEmail}` : 'Copy failed');
  });
  return btn;
}

function statusCell(res, saveState) {
  if (res.status === 'error') {
    return h('span', { class: 'status status-error', text: res.error || 'Error' });
  }
  const label = {
    saved: res.status === 'password_protected' ? 'Password protected · saved' : 'Saved',
    'not-shopify': 'Not saved (not Shopify)',
    'save-failed': 'Scanned, save failed',
  }[saveState];
  const cls = saveState === 'saved' ? 'status-ok' : saveState === 'save-failed' ? 'status-error' : 'status-muted';
  return h('span', { class: `status ${cls}`, text: label });
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
            copyButton(e.email)
          )
        )
      )
    )
  );
}

function resultRows(orig, saveState) {
  const res = applyTagFilter(orig, tagFilter);
  if (!res) return [];
  const others = res.emails.filter((e) => e.email !== res.bestEmail).length;
  const detail = res.emails.length ? detailRow(res, 7) : null;
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
    h('td', { class: 'cell-store' }, res.storeName || displayHost(res.url || res.input) || res.input),
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
    h('td', {}, socialLinks(res.socials) || h('span', { class: 'muted', text: '—' })),
    h('td', {}, statusCell(res, saveState))
  );
  return detail ? [row, detail] : [row];
}

function renderHiddenNote(el, hidden, noun) {
  el.textContent = hidden ? `${hidden} ${noun}${hidden === 1 ? '' : 's'} hidden by the email filter` : '';
  el.hidden = !hidden;
}

/** Re-render the whole results table (after a filter change). */
function renderResults() {
  const rows = runResults.flatMap(({ res, saveState }) => resultRows(res, saveState));
  rows.forEach((r) => r.classList.remove('row-new'));
  $('resultsBody').replaceChildren(...rows);
  const shown = runResults.filter(({ res }) => applyTagFilter(res, tagFilter)).length;
  $('resultsWrap').hidden = shown === 0;
  renderHiddenNote($('resultsHidden'), runResults.length - shown, 'store');
}

/** Add one finished store to the results table. */
function addResult(res, saveState) {
  runResults.push({ res, saveState });
  const rows = resultRows(res, saveState);
  $('resultsBody').append(...rows);
  if (rows.length) $('resultsWrap').hidden = false;
  const shown = runResults.filter((r) => applyTagFilter(r.res, tagFilter)).length;
  renderHiddenNote($('resultsHidden'), runResults.length - shown, 'store');
}

/* -------------------------------------------------------------------------- */
/* Bulk run                                                                   */
/* -------------------------------------------------------------------------- */

function setRunning(running) {
  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
  $('urls').disabled = running;
  document.querySelectorAll('input[name="concurrency"], #shopifyOnly, #skipSaved').forEach((el) => {
    el.disabled = running;
  });
  $('startBtn').textContent = running ? 'Scanning…' : 'Start scan';
}

function renderProgress(stats, active) {
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  $('barFill').style.width = `${pct}%`;
  $('bar').setAttribute('aria-valuenow', String(pct));
  let text = `${stats.done} of ${stats.total} scanned, ${stats.emails} email${stats.emails === 1 ? '' : 's'} found`;
  if (stats.skipped) text += ` · ${stats.skipped} skipped (already saved)`;
  $('progressText').textContent = text;
  $('activeText').textContent = active && active.size ? `Scanning ${[...active].map(displayHost).join(', ')}` : '';
}

function savedOriginSet(leads) {
  const set = new Set(Object.keys(leads));
  for (const l of Object.values(leads)) {
    const n = normalizeInput(l.input || '');
    if (n.ok) set.add(n.origin);
  }
  return set;
}

async function start() {
  const { origins } = parseUrlList($('urls').value);
  if (!origins.length) {
    toast('Paste at least one store URL');
    $('urls').focus();
    return;
  }

  let queue = origins;
  let skipped = 0;
  if ($('skipSaved').checked) {
    const saved = savedOriginSet(await getLeads());
    queue = origins.filter((o) => !saved.has(o));
    skipped = origins.length - queue.length;
  }

  $('run').hidden = false;
  runResults = [];
  $('resultsBody').replaceChildren();
  $('resultsWrap').hidden = true;
  renderHiddenNote($('resultsHidden'), 0, 'store');

  const stats = { total: queue.length, done: 0, emails: 0, skipped };
  const active = new Set();
  renderProgress(stats, active);

  if (!queue.length) {
    $('progressText').textContent = `All ${skipped} store${skipped === 1 ? ' is' : 's are'} already saved. Uncheck “Skip stores already saved” to re-scan.`;
    return;
  }

  controller = new AbortController();
  const { signal } = controller;
  const shopifyOnly = $('shopifyOnly').checked;
  setRunning(true);

  await runPool(
    queue,
    concurrency(),
    async (url) => {
      active.add(url);
      renderProgress(stats, active);
      const res = await scanStore(url, { signal });
      active.delete(url);
      if (signal.aborted) return; // stopped mid-scan: drop the partial result

      let saveState = 'error';
      if (res.status !== 'error') {
        if (shopifyOnly && !res.isShopify) {
          saveState = 'not-shopify';
        } else {
          try {
            await saveLead(res);
            saveState = 'saved';
          } catch {
            saveState = 'save-failed';
          }
        }
      }
      stats.done++;
      stats.emails += res.emails.length;
      addResult(res, saveState);
      renderProgress(stats, active);
    },
    signal
  );

  const wasStopped = signal.aborted;
  controller = null;
  setRunning(false);
  renderProgress(stats, null);
  if (wasStopped) {
    $('progressText').textContent += ' · Stopped';
  } else {
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
    .map((l) => applyTagFilter(rescoreLead(l), tagFilter))
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
      href
        ? h('small', {}, h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: displayHost(href) }))
        : null
    ),
    h('td', {}, bestEmailCell(lead, { withTag: false })),
    h('td', {}, best ? tagBadge(best.tag) : h('span', { class: 'muted', text: '—' })),
    h('td', { title: (lead.emails || []).map((e) => e.email).join('\n') }, String((lead.emails || []).length)),
    h('td', { class: 'nowrap' }, (lead.phones || [])[0] || h('span', { class: 'muted', text: '—' })),
    h('td', {}, socialLinks(lead.socials) || h('span', { class: 'muted', text: '—' })),
    h(
      'td',
      { class: 'nowrap muted', title: scanned ? scanned.toLocaleString() : '' },
      scanned ? scanned.toLocaleDateString() : '—'
    ),
    h('td', {}, del)
  );
}

function renderSaved() {
  const all = Object.keys(savedLeads).length;
  const rows = visibleLeads();
  $('savedCount').textContent = String(all);
  $('savedCountTop').textContent = `${all} saved lead${all === 1 ? '' : 's'}`;
  $('savedBody').replaceChildren(...rows.map(savedRow));

  const empty = $('savedEmpty');
  if (!all) {
    empty.querySelector('h3').textContent = 'No saved leads yet';
    empty.querySelector('p').textContent = 'Scan a list above, or open a store and click “Save lead” in the extension popup.';
  } else if (!rows.length) {
    empty.querySelector('h3').textContent = 'No matches';
    empty.querySelector('p').textContent = isFilterActive(tagFilter)
      ? 'No saved lead has an email with the selected tags. Switch more tags on in the email filter.'
      : 'Try a different name, domain or email.';
  }
  empty.hidden = rows.length > 0;
  $('savedWrap').hidden = rows.length === 0;

  const q = $('search').value.trim();
  const searched = Object.values(savedLeads).filter((l) => leadMatches(l, q)).length;
  renderHiddenNote($('savedHidden'), searched - rows.length, 'lead');
  const filtered = rows.length !== all || isFilterActive(tagFilter);
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
  $('urls').addEventListener('input', updateUrlCount);
  $('startBtn').addEventListener('click', start);
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

  onLeadsChanged((leads) => {
    savedLeads = leads;
    scheduleRenderSaved();
  });
  savedLeads = await getLeads();
  renderFilterBar();
  renderSaved();
  updateUrlCount();
}

init();
