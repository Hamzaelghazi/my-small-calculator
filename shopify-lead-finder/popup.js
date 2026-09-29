import { scanStore, normalizeInput, rescoreLead, leadPhoneDetails, PHONE_TYPES } from './lib/scanner.js';
import { getLeads, saveLead, onLeadsChanged, getHistory, recordScans } from './lib/storage.js';
import { buildScanIndex, describePrevious } from './lib/history.js';
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
    links.length ? h('div', { class: 'state-links' }, links) : null
  );
  el.classList.toggle('is-error', error);
  el.hidden = false;
}

function hideMessage() {
  $('message').hidden = true;
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
    )
  );
}

function renderEmptyEmails(res) {
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
          h('span', { class: 'email-meta' }, tagBadge(e.tag), h('span', { text: `Score ${e.score}` }))
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

function render(res) {
  const out = $('results');
  hideMessage();
  platformBadge(res);

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

  const res = await scanStore(origin, {
    onProgress: (p) => {
      $('progressText').textContent = progressText(p);
    },
  });
  try {
    await recordScans([{ result: res, origin }]);
  } catch {
    /* history is a convenience; the scan result still shows */
  }

  $('progress').hidden = true;
  btn.disabled = false;
  btn.textContent = 'Scan again';
  current = res;
  render(res);
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
    render(current);
    setSaved(true);
  }
  await loadPrevious();
  renderSeen();
  if (previous) $('scanBtn').textContent = 'Scan again';
}

init();
