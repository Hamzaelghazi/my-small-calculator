import { scanStore, normalizeInput } from './lib/scanner.js';
import { getLeads, saveLead, onLeadsChanged } from './lib/storage.js';
import { h, copyButton, tagBadge, socialLinks, safeHref, displayHost } from './lib/ui.js';

const $ = (id) => document.getElementById(id);

/** Origin of the active tab, or null when it isn't a website. */
let origin = null;
/** Latest scan result (or the saved lead for this store). */
let current = null;

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
  if (!res.phones.length) return null;
  return h(
    'section',
    { class: 'section' },
    h('h3', { class: 'section-title', text: 'Phone' }),
    h('div', { class: 'phone-list' }, res.phones.map((p) => h('a', { href: `tel:${p}`, text: p })))
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
      renderOthers(res),
      renderStore(res),
      renderPhones(res),
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

  $('progress').hidden = true;
  btn.disabled = false;
  btn.textContent = 'Scan again';
  current = res;
  render(res);
  setSaved(false);
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
    current = saved;
    render(saved);
    setSaved(true);
    $('scanBtn').textContent = 'Scan again';
  }
}

init();
