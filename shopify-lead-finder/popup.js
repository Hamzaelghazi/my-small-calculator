import { scanStore, normalizeInput, rescoreLead, leadPhoneDetails, PHONE_TYPES } from './lib/scanner.js';
import { getLeads, saveLead, onLeadsChanged, getHistory, recordScans } from './lib/storage.js';
import { buildScanIndex, describePrevious } from './lib/history.js';
import {
  isCrazyDomainsHosted,
  hostingLabel,
  getCrazyDomainsOnly,
  setCrazyDomainsOnly,
  checkEmailDomains,
  cachedDsResult,
  dsLabel,
  getDsOnly,
  setDsOnly,
} from './lib/dns.js';
import { applyMailFilter } from './lib/filters.js';
import { h, copyButton, tagBadge, socialLinks, safeHref, displayHost } from './lib/ui.js';

const $ = (id) => document.getElementById(id);

/** Origin of the active tab, or null when it isn't a website. */
let origin = null;
/** Latest scan result (or the saved lead for this store). */
let current = null;

/** Earlier scans of this store, looked up when the popup opens. */
let previous = null;

async function loadPrevious() {
  try {
    const [leads, history] = await Promise.all([getLeads(), getHistory()]);
    previous = buildScanIndex(leads, history).get(origin) || null;
  } catch {
    previous = null;
  }
}

/** Show whether (and when) this store was scanned before opening the popup. */
function renderSeen(afterScan = false) {
  const el = $('seen');
  el.hidden = !previous;
  if (previous) {
    el.replaceChildren(h('strong', { text: afterScan ? 'Scanned before. ' : 'Already scanned. ' }), describePrevious(previous));
  }
}

function setCount(n) {
  $('savedCount').textContent = `${n} saved`;
}

function setSaved(saved) {
  const btn = $('saveBtn');
  btn.textContent = saved ? 'Saved' : 'Save lead';
  btn.classList.toggle('is-done', saved);
  btn.disabled = saved || !current || current.status === 'error';
}

function showMessage({ title, body, links = [], error = false }) {
  const el = $('message');
  el.replaceChildren(
    h('h2', { text: title }),
    h('p', { text: body }),
    ...(links.length ? [h('div', { class: 'state-links' }, links)] : [])
  );
  el.classList.toggle('is-error', error);
  el.hidden = false;
}

function hideMessage() {
  $('message').hidden = true;
}

/** "Crazy Domains (NS)" / "(MX)" badge next to the platform badge. */
function hostingBadge(res) {
  const el = $('hosting');
  const label = hostingLabel(res && res.hosting);
  el.hidden = !label;
  el.textContent = label;
  el.title = label ? `Matched ${res.hosting.type === 'mx' ? 'mail server' : 'nameserver'}: ${res.hosting.evidence}` : '';
}

function platformBadge(res) {
  const el = $('platform');
  el.className = `badge ${res.isShopify ? 'badge-shopify' : ''}`;
  el.textContent = res.isShopify ? 'Shopify store' : 'Not Shopify';
  el.hidden = false;
}

function linkButton(label, href) {
  return h('a', { class: 'btn btn-small', href, target: '_blank', rel: 'noopener noreferrer', text: label });
}

/** What to tell the user after a failed scan. */
function errorAdvice(error) {
  if (/timed out/i.test(error)) return 'The store took too long to respond. Try again, or check that the site loads in this tab.';
  if (/blocked/i.test(error)) return "The site refused the request. Open the store's contact page and look for an email by hand.";
  if (/not found/i.test(error)) return 'The homepage returned "not found". Check the address and try again.';
  if (/couldn't connect/i.test(error)) return 'Check your connection and that the site loads, then scan again.';
  if (/not a web page/i.test(error)) return 'This tab isn’t showing a normal web page. Open the store’s homepage and scan again.';
  return 'Try again in a moment. If it keeps failing, use the store’s contact page.';
}

function renderHero(res) {
  const best = res.emails.find((e) => e.email === res.bestEmail);
  const where = best.sources.slice(0, 2).join(', ');
  return h(
    'section',
    { class: 'hero', 'aria-label': 'Best email' },
    h('div', { class: 'hero-label', text: 'Best email' }),
    h(
      'div',
      { class: 'hero-row' },
      h('span', { class: 'hero-email', text: best.email }),
      copyButton(best.email, { className: 'btn btn-primary btn-small' })
    ),
    h(
      'div',
      { class: 'hero-meta' },
      tagBadge(best.tag),
      h('span', { text: `Score ${best.score}` }),
      where ? h('span', { text: `Found on ${where}` }) : null
    ),
    mailEvidence(best)
  );
}

/**
 * ds.network badge plus the matched mail server, shown only when the
 * ds.network filter is on (emails then carry a `mail` result).
 */
function mailEvidence(e) {
  if (!e.mail || !e.mail.detected) return null;
  return h(
    'div',
    { class: 'mail-evidence' },
    h('span', { class: 'badge badge-hosting', text: dsLabel(e.mail) }),
    h('span', { class: 'mono', text: e.mail.evidence })
  );
}

function renderEmptyEmails(res) {
  if (res.dsHidden) {
    return h(
      'div',
      { class: 'state' },
      h('h2', { text: 'No emails hosted on ds.network' }),
      h('p', {
        text: `${res.dsHidden} email${res.dsHidden === 1 ? ' was' : 's were'} found, but none use ds.network mail servers. Turn off the filter to see them.`,
      })
    );
  }
  const links = [];
  if (res.url) links.push(linkButton('Contact page', `${res.url}/pages/contact`));
  if (safeHref(res.socials.instagram)) links.push(linkButton('Instagram', res.socials.instagram));
  return h(
    'div',
    { class: 'state' },
    h('h2', { text: 'No public email found' }),
    h('p', { text: "Try the store's contact form or Instagram." }),
    links.length ? h('div', { class: 'state-links' }, links) : null
  );
}

function renderOthers(res) {
  const others = res.emails.filter((e) => e.email !== res.bestEmail);
  if (!others.length) return null;
  return h(
    'section',
    { class: 'section' },
    h('h3', { class: 'section-title', text: `Other emails (${others.length})` }),
    h(
      'ul',
      { class: 'email-list' },
      others.map((e) =>
        h(
          'li',
          { class: 'email-item' },
          h('span', { class: 'email-addr', text: e.email }),
          copyButton(e.email),
          h('span', { class: 'email-meta' }, tagBadge(e.tag), h('span', { text: `Score ${e.score}` })),
          mailEvidence(e)
        )
      )
    )
  );
}

function renderSales(res) {
  const est = res.sales;
  if (!est) return null;
  return h(
    'section',
    { class: 'section' },
    h('h3', { class: 'section-title', text: 'Estimated size' }),
    h(
      'div',
      { class: 'sales' },
      h(
        'div',
        { class: 'sales-row' },
        h('span', { class: 'sales-range', text: est.range }),
        h('span', { class: 'badge badge-size', text: est.label })
      ),
      h('div', { class: 'sales-offer' }, 'Suggested offer: ', h('strong', { text: est.offer })),
      est.reasons.length ? h('p', { class: 'sales-reasons', text: est.reasons.join(' · ') }) : null,
      h('p', {
        class: 'sales-note',
        text: `Rough estimate from public signals (${est.confidence} confidence). Not real sales data.`,
      })
    )
  );
}

function renderStore(res) {
  return h(
    'section',
    { class: 'section' },
    h('h3', { class: 'section-title', text: 'Store' }),
    h(
      'div',
      { class: 'store-row' },
      h('span', { class: 'store-name', text: res.storeName || displayHost(res.url) }),
      res.myshopifyDomain ? h('span', { class: 'mono', text: res.myshopifyDomain }) : null
    )
  );
}

function renderPhones(res) {
  const phones = leadPhoneDetails(res);
  if (!phones.length) return null;
  return h(
    'section',
    { class: 'section' },
    h('h3', { class: 'section-title', text: phones.length > 1 ? `Phone (${phones.length})` : 'Phone' }),
    h(
      'ul',
      { class: 'email-list' },
      phones.map((d, i) => {
        const isWa = d.types.includes(PHONE_TYPES.WHATSAPP);
        return h(
          'li',
          { class: 'email-item' },
          h(
            'span',
            { class: 'email-addr' },
            h('a', { class: i === 0 ? 'phone-best' : '', href: `tel:${d.phone}`, text: d.phone, title: 'Call' }),
            isWa
              ? h('a', {
                  class: 'wa-link',
                  href: `https://wa.me/${d.phone.replace(/\D/g, '')}`,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  text: 'WhatsApp',
                })
              : null
          ),
          copyButton(d.phone),
          h(
            'span',
            { class: 'email-meta' },
            i === 0 ? h('span', { class: 'badge badge-business', text: 'best to call' }) : null,
            h('span', { text: `Found in ${d.types.join(', ')}` })
          )
        );
      })
    )
  );
}

function renderSocials(res) {
  const links = socialLinks(res.socials);
  if (!links) return null;
  return h('section', { class: 'section' }, h('h3', { class: 'section-title', text: 'Socials' }), links);
}

/**
 * Render a result through the optional ds.network email filter.
 * Off: exactly what render() always showed. On: look up the MX records of
 * each email's domain (cached), then show only the emails that match.
 * `current` itself is never changed, so saving keeps every email.
 */
async function show(res) {
  if (!$('dsOnly').checked || res.status === 'error' || !res.emails.length) {
    render(res);
    return;
  }
  $('progressText').textContent = 'Checking mail servers…';
  $('progress').hidden = false;
  await checkEmailDomains([res]);
  $('progress').hidden = true;
  const filtered = applyMailFilter(res, cachedDsResult);
  render(filtered || { ...res, emails: [], bestEmail: null, dsHidden: res.emails.length });
}

function render(res) {
  const out = $('results');
  hideMessage();
  platformBadge(res);
  hostingBadge(res);

  if (res.status === 'error') {
    out.hidden = true;
    showMessage({ title: res.error || 'Scan failed', body: errorAdvice(res.error || ''), error: true });
    return;
  }

  if (res.status === 'password_protected') {
    showMessage({
      title: 'Store password protected',
      body: "This store isn't open to the public yet, so only its password page was checked.",
    });
  }

  const when = res.scannedAt ? new Date(res.scannedAt).toLocaleString() : '';
  out.replaceChildren(
    ...[
      res.bestEmail ? renderHero(res) : renderEmptyEmails(res),
      renderPhones(res),
      renderOthers(res),
      renderStore(res),
      renderSales(res),
      renderSocials(res),
      h('p', {
        class: 'meta-line',
        text: `Checked ${res.pagesChecked.length} page${res.pagesChecked.length === 1 ? '' : 's'}${when ? ` · ${when}` : ''}`,
      }),
    ].filter(Boolean)
  );
  out.hidden = false;
}

function progressText(p) {
  if (p.step === 'homepage') return 'Checking homepage…';
  if (p.step === 'done') return 'Ranking emails…';
  return `Checked ${p.path} (${p.done} of ${p.total})`;
}

async function scan() {
  if (!origin) return;
  const btn = $('scanBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  $('saveBtn').disabled = true;
  $('results').hidden = true;
  hideMessage();
  $('progressText').textContent = 'Checking homepage…';
  $('progress').hidden = false;

  // Crazy Domains filter: check DNS first (two small queries) and only run
  // the full page scan when the store matches.
  let hosting = null;
  if ($('cdOnly').checked) {
    $('progressText').textContent = 'Checking DNS for Crazy Domains…';
    hosting = await isCrazyDomainsHosted(origin);
    if (!hosting.detected) {
      $('progress').hidden = true;
      btn.disabled = false;
      btn.textContent = 'Scan this store';
      $('platform').hidden = true;
      hostingBadge(null);
      showMessage(
        hosting.error
          ? {
              title: 'Couldn’t check DNS',
              body: `${hosting.error}. Try again, or turn off “Only show Crazy Domains hosted stores” to scan it anyway.`,
              error: true,
            }
          : {
              title: 'Not hosted on Crazy Domains',
              body: 'Its nameservers and mail servers don’t point at Crazy Domains, so it was skipped. Turn off the toggle to scan it anyway.',
            }
      );
      return;
    }
    $('progressText').textContent = 'Checking homepage…';
  }

  const res = await scanStore(origin, {
    onProgress: (p) => {
      $('progressText').textContent = progressText(p);
    },
  });
  if (hosting) res.hosting = hosting;
  try {
    await recordScans([{ result: res, origin }]);
  } catch {
    /* history is a convenience; the scan result still shows */
  }

  $('progress').hidden = true;
  btn.disabled = false;
  btn.textContent = 'Scan again';
  current = res;
  await show(res);
  setSaved(false);
  renderSeen(true);
}

async function save() {
  if (!current || current.status === 'error') return;
  const btn = $('saveBtn');
  btn.disabled = true;
  try {
    await saveLead(current);
    setSaved(true);
  } catch {
    btn.disabled = false;
    showMessage({ title: 'Couldn’t save this lead', body: 'Storage is unavailable. Try again.', error: true });
  }
}

async function findSaved(leads) {
  if (leads[origin]) return leads[origin];
  return Object.values(leads).find((l) => {
    const n = normalizeInput(l.input || '');
    return n.ok && n.origin === origin;
  });
}

async function init() {
  $('scanBtn').addEventListener('click', scan);
  // The toggle is shared with the bulk scanner through chrome.storage.local.
  $('cdOnly').checked = await getCrazyDomainsOnly();
  $('cdOnly').addEventListener('change', () => setCrazyDomainsOnly($('cdOnly').checked));
  // ds.network email filter: re-filter what's on screen when it changes. No re-scan needed.
  $('dsOnly').checked = await getDsOnly();
  $('dsOnly').addEventListener('change', async () => {
    await setDsOnly($('dsOnly').checked);
    if (current) await show(current);
  });
  $('saveBtn').addEventListener('click', save);
  $('openDashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    window.close();
  });

  let leads = {};
  try {
    leads = await getLeads();
  } catch {
    /* storage unavailable; carry on */
  }
  setCount(Object.keys(leads).length);
  onLeadsChanged((l) => setCount(Object.keys(l).length));

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  const url = tab && tab.url ? tab.url : '';
  const n = /^https?:\/\//i.test(url) ? normalizeInput(url) : { ok: false };
  if (!n.ok) {
    $('domain').textContent = 'No website in this tab';
    showMessage({
      title: 'Open a store to scan it',
      body: "Go to a store's website in this tab, then click the extension again. To scan a list of stores, use the bulk scanner.",
    });
    return;
  }

  origin = n.origin;
  $('domain').textContent = displayHost(origin);
  $('domain').title = origin;
  $('scanBtn').disabled = false;

  const saved = await findSaved(leads);
  if (saved) {
    current = rescoreLead(saved);
    await show(current);
    setSaved(true);
  }
  await loadPrevious();
  renderSeen();
  if (previous) $('scanBtn').textContent = 'Scan again';
}

init();
