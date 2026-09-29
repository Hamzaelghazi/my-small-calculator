// Run with: node --test test/scanner.test.mjs   (from the shopify-lead-finder folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInput,
  parseUrlList,
  extractEmails,
  isJunkEmail,
  rankEmails,
  decodeCfEmail,
  detectShopify,
  extractStoreName,
  extractPhones,
  extractSocials,
  findFollowLinks,
  scanStore,
} from '../lib/scanner.js';
import { leadsToCsv, csvCell } from '../lib/csv.js';

/** Encode an address the way Cloudflare's email protection does. */
function cfEncode(email, key = 0x5a) {
  const hex = (n) => n.toString(16).padStart(2, '0');
  return hex(key) + [...email].map((c) => hex(c.charCodeAt(0) ^ key)).join('');
}

test('normalizeInput reduces to origin and rejects junk', () => {
  assert.deepEqual(normalizeInput('  Brand.com/products/x?y=1 '), { ok: true, origin: 'https://brand.com' });
  assert.deepEqual(normalizeInput('http://www.brand.co.uk'), { ok: true, origin: 'http://www.brand.co.uk' });
  assert.equal(normalizeInput('not a url').ok, false);
  assert.equal(normalizeInput('localhost').ok, false);
  assert.equal(normalizeInput('ftp://brand.com').ok, false);
  assert.equal(normalizeInput('').ok, false);
});

test('parseUrlList dedupes and counts invalid', () => {
  const r = parseUrlList('brand.com, https://brand.com/pages/about\nother.io\n\nnope');
  assert.deepEqual(r.origins, ['https://brand.com', 'https://other.io']);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.invalid, ['nope']);
});

test('plain email in text', () => {
  assert.deepEqual(extractEmails('<p>Email us at Hello@Brand.com.</p>'), ['hello@brand.com']);
});

test('mailto with query string', () => {
  const html = '<a href="mailto:sales@brand.com?subject=Wholesale%20inquiry&amp;body=Hi">Write to us</a>';
  assert.deepEqual(extractEmails(html), ['sales@brand.com']);
});

test('Cloudflare data-cfemail and email-protection link', () => {
  const html = `
    <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cfEncode('owner@brand.com')}">[email&#160;protected]</a>
    <a href="/cdn-cgi/l/email-protection#${cfEncode('info@brand.com', 0x21)}">Email</a>`;
  assert.equal(decodeCfEmail(cfEncode('x@y.co')), 'x@y.co');
  assert.deepEqual(extractEmails(html).sort(), ['info@brand.com', 'owner@brand.com']);
});

test('[at] / [dot] style obfuscation', () => {
  const html = `
    <p>jane [at] brand [dot] com</p>
    <p>orders (at) brand.co.uk</p>
    <p>press{at}brand{dot}com</p>`;
  assert.deepEqual(extractEmails(html).sort(), ['jane@brand.com', 'orders@brand.co.uk', 'press@brand.com']);
});

test('entity, URL and JS escapes', () => {
  const html = `
    <span>care&#64;brand&#46;com</span>
    <span>team&#x40;brand.com</span>
    <script>var e = "wholesale\\u0040brand.com"; var j = "\\u003einfo@brand.com\\u003c";</script>
    <a href="https://x.com/?to=ceo%40brand.com">x</a>`;
  assert.deepEqual(
    extractEmails(html).sort(),
    ['care@brand.com', 'ceo@brand.com', 'info@brand.com', 'team@brand.com', 'wholesale@brand.com']
  );
});

test('junk filters', () => {
  const junk = [
    'logo@2x.png',
    'icon@3x.webp',
    'bundle@1.0.0.js',
    'abc@o123.ingest.sentry.io',
    'x@sentry.wixpress.com',
    'you@example.com',
    'name@domain.com',
    'your@email.com',
    'me@yourdomain.com',
    'help@shopify.com',
    'store@brand.myshopify.com',
    'a@godaddy.com',
    'x@sentry-next.wixpress.com',
    `${'a'.repeat(65)}@brand.com`,
    '5f2b8c9d0e1a2b3c4d5e6f7a8b9c@brand.com',
  ];
  for (const e of junk) assert.equal(isJunkEmail(e), true, e);
  for (const e of ['info@brand.com', 'jane.doe@gmail.com', 'orders@brand.co.uk']) {
    assert.equal(isJunkEmail(e), false, e);
  }

  // And end to end through extraction + ranking
  const html = '<img src="logo@2x.png"><p>info@brand.com you@example.com</p>';
  const ranked = rankEmails(
    new Map(extractEmails(html).map((e) => [e, new Set(['/'])])),
    { storeDomains: ['brand.com'], storeSlugs: ['brand'] }
  );
  assert.deepEqual(ranked.map((r) => r.email), ['info@brand.com']);
});

test('scoring order and tags', () => {
  const sources = new Map([
    ['noreply@brand.com', new Set(['/'])],
    ['support@brand.com', new Set(['/pages/faq'])],
    ['brandowner.jane@gmail.com', new Set(['/pages/about'])],
    ['info@brand.com', new Set(['/pages/contact'])],
    ['founder@brand.com', new Set(['/pages/about'])],
    ['random@othersite.com', new Set(['/'])],
  ]);
  const ranked = rankEmails(sources, { storeDomains: ['brand.com'], storeSlugs: ['glowbrand'] });
  assert.deepEqual(
    ranked.map((r) => [r.email, r.score, r.tag]),
    [
      ['founder@brand.com', 6, 'likely owner'],
      ['info@brand.com', 6, 'business'],
      ['support@brand.com', 4, 'support'],
      ['brandowner.jane@gmail.com', 2, 'personal inbox'],
      ['random@othersite.com', 0, 'business'],
      ['noreply@brand.com', -2, 'no-reply'],
    ]
  );
});

test('store name local part scores as likely owner', () => {
  const ranked = rankEmails(new Map([['glowbrand@gmail.com', new Set(['/'])], ['hello@glowbrand.com', new Set(['/'])]]), {
    storeDomains: ['glowbrand.com'],
    storeSlugs: ['glowbrand'],
  });
  assert.equal(ranked[0].email, 'glowbrand@gmail.com');
  assert.equal(ranked[0].tag, 'likely owner');
  assert.equal(ranked[0].score, 5);
});

test('Shopify detection and store name', () => {
  const html = `<html><head><title>Glow Brand – Home</title>
    <script>Shopify.shop = "glow-brand.myshopify.com"; Shopify.theme = {};</script></head></html>`;
  assert.deepEqual(detectShopify(html, new Headers()), { isShopify: true, myshopifyDomain: 'glow-brand.myshopify.com' });
  assert.equal(detectShopify('<html></html>', new Headers({ 'x-shopid': '123' })).isShopify, true);
  assert.equal(detectShopify('<html></html>', new Headers({ 'powered-by': 'Shopify' })).isShopify, true);
  assert.equal(detectShopify('<html></html>', new Headers()).isShopify, false);
  assert.equal(extractStoreName(html), 'Glow Brand');
  assert.equal(extractStoreName('<title>Home | Glow &amp; Co</title>'), 'Glow & Co');
  assert.equal(extractStoreName('<meta content="Real Name" property="og:site_name"><title>x</title>'), 'Real Name');
});

test('phones from tel: links only, deduped', () => {
  const html = `<a href="tel:+1 (555) 123-4567">Call</a> <a href="tel:+15551234567">again</a>
    <p>Call 555-999-0000</p><a href="tel:12">bad</a>`;
  assert.deepEqual(extractPhones(html), ['+15551234567']);
});

test('socials skip share links and take profiles', () => {
  const html = `
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
    <a href="https://twitter.com/intent/tweet?text=x">tweet</a>
    <a href="https://www.instagram.com/p/ABC123/">post</a>
    <a href="https://www.tiktok.com/music/x">music</a>
    <a href="https://www.youtube.com/watch?v=1">vid</a>
    <a href="https://instagram.com/glowbrand/">ig</a>
    <a href="https://www.facebook.com/glowbrand">fb</a>
    <a href="https://www.tiktok.com/@glowbrand?lang=en">tt</a>
    <a href="https://www.linkedin.com/company/glow-brand/">li</a>
    <a href="https://x.com/glowbrand">x</a>
    <a href="https://www.youtube.com/@glowbrand">yt</a>
    <a href="https://www.pinterest.com/glowbrand/">pin</a>`;
  assert.deepEqual(extractSocials([html]), {
    instagram: 'https://www.instagram.com/glowbrand',
    facebook: 'https://www.facebook.com/glowbrand',
    tiktok: 'https://www.tiktok.com/@glowbrand',
    linkedin: 'https://www.linkedin.com/company/glow-brand',
    x: 'https://x.com/glowbrand',
    youtube: 'https://www.youtube.com/@glowbrand',
    pinterest: 'https://www.pinterest.com/glowbrand',
  });
});

test('follow links: same origin, matching, not already queued, max 3', () => {
  const html = `
    <a href="/pages/contact">Contact</a>
    <a href="/pages/wholesale">Wholesale</a>
    <a href="https://other.com/contact">Other</a>
    <a href="/pages/our-story">About us</a>
    <a href="/pages/help-center">Support</a>
    <a href="/pages/about-the-team">Team</a>`;
  const out = findFollowLinks(html, 'https://brand.com', new Set(['/pages/contact']));
  assert.deepEqual(out, ['/pages/wholesale', '/pages/our-story', '/pages/help-center']);
});

test('csv escaping', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK()'), "'=HYPERLINK()");
  assert.equal(csvCell('+15551234567'), '+15551234567');
  const csv = leadsToCsv([
    {
      storeName: 'Glow, Co',
      url: 'https://brand.com',
      isShopify: true,
      emails: [{ email: 'a@brand.com', tag: 'business' }, { email: 'b@brand.com', tag: 'support' }],
      bestEmail: 'a@brand.com',
      phones: [],
      socials: {},
      status: 'ok',
      scannedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  const [header, row] = csv.trim().split('\r\n');
  assert.equal(header.split(',').length, 17);
  assert.ok(row.startsWith('"Glow, Co",https://brand.com,yes,,a@brand.com,business,"a@brand.com; b@brand.com"'));
});

/* ---------------------------- scanStore end to end ---------------------------- */

function mockFetch(routes) {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const route = routes[u.pathname];
    if (!route) return fakeResponse(url, 404, 'Not found');
    if (route.redirect) return fetchImpl(new URL(route.redirect, url).href);
    return fakeResponse(url, route.status || 200, route.body, route.headers);
  };
  return fetchImpl;
}

function fakeResponse(url, status, body, headers = {}) {
  const res = new Response(status === 204 ? null : body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

test('scanStore end to end', async () => {
  const home = `<html><head><meta property="og:site_name" content="Glow Brand">
    <script src="https://cdn.shopify.com/s/files/x.js"></script>
    <script>Shopify.shop = "glow-brand.myshopify.com";</script></head>
    <body><a href="/pages/wholesale">Wholesale</a>
    <a href="https://instagram.com/glowbrand">IG</a>
    <img src="/logo@2x.png"></body></html>`;
  const progress = [];
  const res = await scanStore('glowbrand.com', {
    fetchImpl: mockFetch({
      '/': { body: home },
      '/pages/contact': { body: '<a href="mailto:hello@glowbrand.com?subject=Hi">hello</a> <a href="tel:+44 20 7946 0000">call</a>' },
      '/policies/privacy-policy': { body: 'Questions: privacy [at] glowbrand [dot] com or noreply@glowbrand.com' },
      '/pages/about': { body: 'Founded by Jane. Reach her at founder@glowbrand.com' },
      '/pages/wholesale': { body: 'wholesale@glowbrand.com' },
      '/pages/faq': { body: 'x', headers: { 'content-type': 'application/pdf' } },
    }),
    onProgress: (p) => progress.push(p.path),
  });

  assert.equal(res.status, 'ok');
  assert.equal(res.url, 'https://glowbrand.com');
  assert.equal(res.storeName, 'Glow Brand');
  assert.equal(res.isShopify, true);
  assert.equal(res.myshopifyDomain, 'glow-brand.myshopify.com');
  assert.equal(res.bestEmail, 'founder@glowbrand.com');
  assert.deepEqual(res.emails.map((e) => e.email), [
    'founder@glowbrand.com',
    'hello@glowbrand.com',
    'wholesale@glowbrand.com',
    'privacy@glowbrand.com',
    'noreply@glowbrand.com',
  ]);
  assert.deepEqual(res.emails.find((e) => e.email === 'hello@glowbrand.com').sources, ['/pages/contact']);
  assert.deepEqual(res.phones, ['+442079460000']);
  assert.equal(res.socials.instagram, 'https://www.instagram.com/glowbrand');
  assert.ok(res.pagesChecked.includes('/pages/wholesale'));
  assert.ok(!res.pagesChecked.includes('/pages/faq'));
  assert.ok(progress.includes('/pages/wholesale'));
});

test('scanStore: redirect sets canonical origin', async () => {
  const fetchImpl = async (url) =>
    fakeResponse(url.replace('https://brand.com', 'https://www.brand.com'), url.endsWith('.com/') ? 200 : 404, '<title>Brand</title>');
  const res = await scanStore('brand.com', { fetchImpl });
  assert.equal(res.url, 'https://www.brand.com');
});

test('scanStore: password protected', async () => {
  const res = await scanStore('https://secret.com', {
    fetchImpl: mockFetch({
      '/': { redirect: '/password' },
      '/password': { body: '<body class="template-password">Contact: owner@secret.com</body>' },
    }),
  });
  assert.equal(res.status, 'password_protected');
  assert.equal(res.error, 'Store password protected');
  assert.equal(res.isShopify, true);
  assert.equal(res.bestEmail, 'owner@secret.com');
});

test('scanStore: errors never throw', async () => {
  assert.equal((await scanStore('not a url')).error, 'Invalid URL');

  const notFound = await scanStore('gone.com', { fetchImpl: mockFetch({}) });
  assert.equal(notFound.status, 'error');
  assert.match(notFound.error, /not found/i);

  const blocked = await scanStore('blocked.com', { fetchImpl: mockFetch({ '/': { status: 403, body: 'no' } }) });
  assert.match(blocked.error, /blocked/i);

  const down = await scanStore('down.com', {
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.match(down.error, /couldn't connect/i);

  const slow = await scanStore('slow.com', {
    timeoutMs: 50,
    fetchImpl: (url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
  });
  assert.match(slow.error, /timed out/i);

  const nonHtml = await scanStore('img.com', {
    fetchImpl: mockFetch({ '/': { body: 'x', headers: { 'content-type': 'image/png' } } }),
  });
  assert.match(nonHtml.error, /not a web page/i);
});

test('scanStore: abort signal stops the scan', async () => {
  const controller = new AbortController();
  const p = scanStore('slow.com', {
    signal: controller.signal,
    fetchImpl: (url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
  });
  setTimeout(() => controller.abort(), 20);
  const res = await p;
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'Scan stopped');
});

test('scanStore: huge pages are capped', async () => {
  const big = '<title>Big</title>' + 'a'.repeat(3 * 1024 * 1024) + ' late@big.com';
  const res = await scanStore('big.com', { fetchImpl: mockFetch({ '/': { body: big } }) });
  assert.equal(res.status, 'ok');
  assert.equal(res.emails.length, 0);
});

test('extraction stays fast on pathological 2MB input', () => {
  const blob = 'a'.repeat(2 * 1024 * 1024);
  const t0 = Date.now();
  const found = extractEmails(`${blob} [at] ${blob}@${blob} hello@brand.com`);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  assert.ok(found.includes('hello@brand.com'));
});
