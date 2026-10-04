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
  rescoreLead,
} from '../lib/scanner.js';
import { leadsToCsv, csvCell } from '../lib/csv.js';
import { applyTagFilter, isFilterActive, applyFilters, PRESETS } from '../lib/filters.js';
import { detectApps, parseMeta, parseProducts, estimateSales, SIZE_ORDER } from '../lib/sales.js';

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
  assert.equal(header.split(',').length, 27);
  assert.ok(row.startsWith('"Glow, Co",https://brand.com,yes,,a@brand.com,business,,"a@brand.com; b@brand.com"'));
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

test('store contact: emails from Shopify policy pages', () => {
  const ranked = rankEmails(
    new Map([
      ['hello.maya@gmail.com', new Set(['/policies/contact-information'])],
      ['legal@brand.com', new Set(['/policies/privacy-policy'])],
      ['founder@brand.com', new Set(['/policies/contact-information'])],
      ['team@brand.com', new Set(['/'])],
    ]),
    { storeDomains: ['brand.com'], storeSlugs: ['brand'] }
  );
  assert.deepEqual(
    ranked.map((r) => [r.email, r.score, r.tag]),
    [
      ['founder@brand.com', 9, 'likely owner'], // owner wins the tag, still gets the bonus
      ['hello.maya@gmail.com', 7, 'store contact'], // hello +2, personal +2, contact page +1, contact info +2
      ['legal@brand.com', 4, 'store contact'],
      ['team@brand.com', 3, 'business'],
    ]
  );
});

test('tag filter keeps matching emails and re-picks the best', () => {
  const lead = {
    url: 'https://brand.com',
    emails: [
      { email: 'info@brand.com', score: 5, tag: 'business', sources: ['/'] },
      { email: 'shop@brand.com', score: 4, tag: 'store contact', sources: ['/policies/contact-information'] },
      { email: 'noreply@brand.com', score: -2, tag: 'no-reply', sources: ['/'] },
    ],
    bestEmail: 'info@brand.com',
  };
  const all = new Set(PRESETS.all);
  assert.equal(isFilterActive(all), false);
  assert.equal(applyTagFilter(lead, all), lead);

  const owner = new Set(PRESETS.owner);
  const f = applyTagFilter(lead, owner);
  assert.deepEqual(f.emails.map((e) => e.email), ['shop@brand.com']);
  assert.equal(f.bestEmail, 'shop@brand.com');
  assert.equal(lead.bestEmail, 'info@brand.com', 'original is untouched');

  assert.equal(applyTagFilter(lead, new Set(['likely owner'])), null);
  assert.equal(applyTagFilter(lead, new Set(['no-reply'])).bestEmail, null);

  const [, row] = leadsToCsv([f]).trim().split('\r\n');
  assert.ok(row.includes(',shop@brand.com,store contact,,shop@brand.com,'), row);
  assert.ok(!row.includes('info@brand.com'));
});

test('rescoreLead upgrades leads saved by an older version', () => {
  const old = {
    input: 'brand.com',
    url: 'https://www.brand.com',
    storeName: 'Brand',
    emails: [
      { email: 'info@brand.com', score: 5, tag: 'business', sources: ['/'] },
      { email: 'hi.anna@gmail.com', score: 3, tag: 'personal inbox', sources: ['/policies/contact-information'] },
    ],
    bestEmail: 'info@brand.com',
  };
  const r = rescoreLead(old);
  assert.equal(r.bestEmail, 'hi.anna@gmail.com');
  assert.equal(r.emails[0].tag, 'store contact');
  assert.equal(r.emails[1].tag, 'business');
  assert.equal(rescoreLead({ emails: [] }).emails.length, 0);
});

/* ------------------------------ sales estimate ------------------------------ */

test('detectApps finds marketing apps and pixels, not look-alike words', () => {
  const html = `<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>
    <script>fbq('init', '123');</script><script src="https://cdn.judge.me/widget.js"></script>
    <script src="https://static.rechargecdn.com/x.js"></script><p>Rechargeable battery</p>`;
  assert.deepEqual(detectApps(html).map((a) => a.name), ['Klaviyo', 'Recharge', 'Judge.me', 'Meta pixel']);
  assert.deepEqual(detectApps('<p>A rechargeable lamp. We affirm quality.</p>'), []);
});

test('parseMeta and parseProducts', () => {
  assert.deepEqual(parseMeta('{"published_products_count":312,"ships_to_countries":["US","CA","GB"],"currency":"USD"}'), {
    productCount: 312,
    countries: 3,
    currency: 'USD',
  });
  assert.equal(parseMeta('<html>'), null);
  const now = Date.parse('2026-09-01T00:00:00Z');
  const products = JSON.stringify({
    products: [
      { updated_at: '2026-08-20T00:00:00Z', variants: [{ price: '20.00' }, { price: '25.00' }] },
      { updated_at: '2026-01-01T00:00:00Z', variants: [{ price: '40.00' }] },
      { updated_at: '2026-08-30T00:00:00Z', variants: [{ price: '0' }, { price: '60.00' }] },
    ],
  });
  assert.deepEqual(parseProducts(products, now), { sampled: 3, medianPrice: 40, recentlyUpdated: 2 });
  assert.equal(parseProducts('nope'), null);
});

test('estimateSales tiers go up with stronger signals', () => {
  const tiny = estimateSales({ meta: { productCount: 6, countries: 1, currency: 'USD' }, products: { sampled: 6, medianPrice: 18, recentlyUpdated: 0 } });
  assert.equal(tiny.tier, 'early');
  assert.equal(tiny.confidence, 'medium');

  const apps = (names) => detectApps(names);
  const mid = estimateSales({
    apps: apps('klaviyo judge.me fbq("init" ttq.load'),
    meta: { productCount: 120, countries: 12, currency: 'USD' },
    products: { sampled: 100, medianPrice: 55, recentlyUpdated: 2 },
  });
  assert.equal(mid.tier, 'mid', JSON.stringify(mid)); // 2 + 1 + 1 + 1 + 2 + 1 = 8

  const big = estimateSales({
    apps: apps('klaviyo yotpo gorgias rebuyengine attn.tv fbq("init" ttq.load klarna'),
    meta: { productCount: 1500, countries: 80, currency: 'USD' },
    products: { sampled: 100, medianPrice: 160, recentlyUpdated: 20 },
    socialCount: 5,
  });
  assert.equal(big.tier, 'enterprise');
  assert.match(big.offer, /Enterprise/);

  const none = estimateSales({});
  assert.equal(none.tier, 'early');
  assert.equal(none.confidence, 'low');
});

test('size filter combines with the tag filter', () => {
  const lead = (tier) => ({
    emails: [{ email: 'a@b.com', score: 5, tag: 'business', sources: ['/'] }],
    bestEmail: 'a@b.com',
    sales: tier ? { tier } : null,
  });
  const allTags = new Set(PRESETS.all);
  const onlyMid = new Set(['mid', 'large']);
  assert.ok(applyFilters(lead('mid'), { tags: allTags, sizes: onlyMid }));
  assert.equal(applyFilters(lead('early'), { tags: allTags, sizes: onlyMid }), null);
  assert.equal(applyFilters(lead(null), { tags: allTags, sizes: onlyMid }), null);
  assert.ok(applyFilters(lead(null), { tags: allTags, sizes: new Set(SIZE_ORDER) }));
  assert.equal(applyFilters(lead('mid'), { tags: new Set(['likely owner']), sizes: onlyMid }), null);
});

test('scanStore adds a sales estimate for Shopify stores and exports it', async () => {
  const res = await scanStore('bigstore.com', {
    fetchImpl: mockFetch({
      '/': {
        body: `<title>Big Store</title><script src="https://cdn.shopify.com/x.js"></script>
          <script src="https://static.klaviyo.com/x.js"></script><script>fbq('init','1')</script>`,
      },
      '/meta.json': {
        body: '{"published_products_count":450,"ships_to_countries":["US","CA"],"currency":"EUR"}',
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
      '/products.json': {
        body: JSON.stringify({ products: [{ variants: [{ price: '80.00' }] }, { variants: [{ price: '120.00' }] }] }),
        headers: { 'content-type': 'application/json' },
      },
      '/pages/contact': { body: 'hello@bigstore.com' },
    }),
  });
  assert.equal(res.status, 'ok');
  assert.ok(res.sales);
  assert.equal(res.sales.productCount, 450);
  assert.equal(res.sales.medianPrice, 100);
  assert.equal(res.sales.currency, 'EUR');
  assert.deepEqual(res.sales.apps, ['Klaviyo', 'Meta pixel']);
  assert.equal(res.sales.tier, 'small'); // 450 products +3, median 100 +1, Klaviyo +1, pixel +1 = 6
  const row = leadsToCsv([res]).trim().split('\r\n')[1];
  assert.ok(row.includes(`${res.sales.range} (estimate),${res.sales.label},${res.sales.offer},450,EUR 100,"Klaviyo; Meta pixel",,OK`), row);

  const plain = await scanStore('plain.com', { fetchImpl: mockFetch({ '/': { body: '<title>Plain</title>' } }) });
  assert.equal(plain.sales, null);
});

/* ------------------------------ phones ------------------------------ */

import { extractPhoneDetails, normalizePhone } from '../lib/scanner.js';
import { buildScanIndex, isAlreadyScanned, describePrevious } from '../lib/history.js';

test('normalizePhone rejects dates, year ranges and junk', () => {
  assert.equal(normalizePhone('+1 (555) 201-8890'), '+15552018890');
  assert.equal(normalizePhone('0044 20 7946 0000'), '+442079460000');
  assert.equal(normalizePhone('2019-2024'), null);
  assert.equal(normalizePhone('12/05/2024'), null);
  assert.equal(normalizePhone('1111111111'), null);
  assert.equal(normalizePhone('12345'), null);
});

test('extractPhoneDetails: tel links, schema, WhatsApp and labelled text', () => {
  const pages = [
    {
      path: '/',
      html: `<script type="application/ld+json">{"@type":"Organization","telephone":"+1-555-300-4000"}</script>
        <footer>© 2019-2024 Brand. <a href="https://wa.me/15557778888">Chat</a></footer>`,
    },
    {
      path: '/pages/contact',
      html: `<p>Phone: (555) 300-4000</p><p>Call us at +44 20 7946 0000 Mon–Fri</p>
        <a href="tel:+15551112222">Call</a><p>Order #1234567 shipped 12/05/2024</p>`,
    },
  ];
  const d = extractPhoneDetails(pages);
  assert.deepEqual(
    d.map((x) => [x.phone, x.types]),
    [
      ['+15551112222', ['call link']],
      ['+15553004000', ['site data', 'page text']],
      ['+15557778888', ['WhatsApp']],
      ['+442079460000', ['page text']],
    ]
  );
});

test('scanStore returns bestPhone and whatsapp', async () => {
  const res = await scanStore('callme.com', {
    fetchImpl: mockFetch({
      '/': { body: '<title>Call Me</title><a href="https://api.whatsapp.com/send?phone=447700900123">WA</a>' },
      '/policies/contact-information': { body: '<p>Phone number: +1 555 010 7788</p><p>Email: hi@callme.com</p>' },
    }),
  });
  assert.equal(res.bestPhone, '+447700900123');
  assert.equal(res.whatsapp, '+447700900123');
  assert.deepEqual(res.phones, ['+447700900123', '+15550107788']);
  const row = leadsToCsv([res]).trim().split('\r\n')[1];
  assert.ok(row.includes(',hi@callme.com,store contact,+447700900123,hi@callme.com,"+447700900123; +15550107788",+447700900123,'), row);
});

/* ------------------------------ scan history ------------------------------ */

test('scan index merges saved leads and history', () => {
  const leads = {
    'https://www.brand.com': { url: 'https://www.brand.com', input: 'brand.com', status: 'ok', isShopify: true, scannedAt: '2026-09-20T10:00:00Z', firstScannedAt: '2026-09-01T10:00:00Z' },
  };
  const history = {
    'https://brand.com': { url: 'https://www.brand.com', firstScannedAt: '2026-09-01T10:00:00Z', lastScannedAt: '2026-09-20T10:00:00Z', count: 3, status: 'ok', isShopify: true },
    'https://plain.com': { url: 'https://plain.com', firstScannedAt: '2026-09-10T10:00:00Z', lastScannedAt: '2026-09-10T10:00:00Z', count: 1, status: 'ok', isShopify: false },
    'https://down.com': { url: 'https://down.com', firstScannedAt: '2026-09-10T10:00:00Z', lastScannedAt: '2026-09-10T10:00:00Z', count: 1, status: 'error', error: 'Timed out after 12s' },
  };
  const index = buildScanIndex(leads, history);
  const brand = index.get('https://brand.com');
  assert.equal(brand.saved, true, 'typed origin maps to the saved lead');
  assert.equal(brand.count, 3);
  assert.ok(isAlreadyScanned(index.get('https://www.brand.com')));
  assert.ok(isAlreadyScanned(index.get('https://plain.com')), 'non-Shopify scans count too');
  assert.equal(isAlreadyScanned(index.get('https://down.com')), false, 'failed scans are retried');
  assert.equal(isAlreadyScanned(index.get('https://new.com')), false);
  assert.match(describePrevious(index.get('https://plain.com')), /Scanned .*2026 · not saved \(not Shopify\)/);
  assert.match(describePrevious(brand), /3 times, first on .* · saved as a lead/);
});

test('has-phone filter', () => {
  const withPhone = { emails: [], phones: ['+15550001111'], bestPhone: '+15550001111' };
  const without = { emails: [], phones: [] };
  const f = { tags: new Set(PRESETS.all), sizes: new Set(SIZE_ORDER), phoneOnly: true };
  assert.ok(applyFilters(withPhone, f));
  assert.equal(applyFilters(without, f), null);
});

/* ------------------------------ Crazy Domains DNS ------------------------------ */

import { lookupCrazyDomains, isCrazyDomainsHosted, getMxRecords, domainCandidates, hostingLabel } from '../lib/dns.js';

/**
 * Fake DoH resolver. `zones` maps name → { NS: [...], MX: [...] }.
 * `fail` makes every request to a host throw (e.g. 'dns.google').
 */
function dohMock(zones, { fail = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(`${u.hostname} ${u.searchParams.get('name')} ${u.searchParams.get('type')}`);
    if (fail.includes(u.hostname)) throw new TypeError('Failed to fetch');
    const name = u.searchParams.get('name');
    const type = Number(u.searchParams.get('type'));
    const z = zones[name] || {};
    const Answer = [];
    if (type === 2) for (const ns of z.NS || []) Answer.push({ name, type: 2, data: ns + '.' });
    // Real MX data is "<priority> <host>."; entries without a priority get 10.
    if (type === 15) for (const mx of z.MX || []) Answer.push({ name, type: 15, data: (/\s/.test(mx) ? mx : '10 ' + mx) + '.' });
    return new Response(JSON.stringify({ Status: zones[name] ? 0 : 3, Answer }), { headers: { 'content-type': 'application/dns-json' } });
  };
  return { fetchImpl, calls };
}

test('domainCandidates walks from host to apex', () => {
  assert.deepEqual(domainCandidates('https://www.shop.brand.com.au/x'), ['shop.brand.com.au', 'brand.com.au', 'com.au']);
  assert.deepEqual(domainCandidates('brand.com'), ['brand.com']);
});

test('Crazy Domains detected by nameserver (from a www/subdomain)', async () => {
  const { fetchImpl } = dohMock({ 'brand.com.au': { NS: ['ns1.crazydomains.com', 'ns2.crazydomains.com'], MX: ['mx.google.com'] } });
  assert.deepEqual(await lookupCrazyDomains('www.shop.brand.com.au', { fetchImpl }), {
    detected: true,
    evidence: 'ns1.crazydomains.com',
    type: 'nameserver',
  });
  const syra = dohMock({ 'x.com': { NS: ['ns1.syrahost.com'] } });
  assert.equal((await lookupCrazyDomains('x.com', { fetchImpl: syra.fetchImpl })).evidence, 'ns1.syrahost.com');
});

test('falls back to MX when NS does not match', async () => {
  const { fetchImpl } = dohMock({ 'brand.com': { NS: ['ns1.cloudflare.com'], MX: ['20 backup.example.net', '10 mx1.ds.network'] } });
  const r = await lookupCrazyDomains('brand.com', { fetchImpl });
  assert.equal(r.detected, true);
  assert.equal(r.type, 'mx');
  assert.equal(r.evidence, 'mx1.ds.network');
  const oxcs = dohMock({ 'b.com': { NS: ['ns.other.net'], MX: ['mail.xion.oxcs.net'] } });
  assert.equal((await lookupCrazyDomains('b.com', { fetchImpl: oxcs.fetchImpl })).evidence, 'mail.xion.oxcs.net');
});

test('MX records sorted by priority', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15, data: '20 b.mx.net.' }, { type: 15, data: '10 a.mx.net.' }, { type: 5, data: 'cname.' }] }));
  assert.deepEqual(await getMxRecords('x.com', { fetchImpl }), ['a.mx.net', 'b.mx.net']);
});

test('not detected, Cloudflare fallback, and total failure', async () => {
  const plain = dohMock({ 'plain.com': { NS: ['ns1.shopify.com'], MX: ['aspmx.l.google.com'] } });
  assert.deepEqual(await lookupCrazyDomains('plain.com', { fetchImpl: plain.fetchImpl }), { detected: false });

  const googleDown = dohMock({ 'cd.com': { NS: ['ns1.crazydomains.com'] } }, { fail: ['dns.google'] });
  const r = await lookupCrazyDomains('cd.com', { fetchImpl: googleDown.fetchImpl });
  assert.equal(r.detected, true);
  assert.ok(googleDown.calls.some((c) => c.startsWith('cloudflare-dns.com')), 'used Cloudflare');

  const allDown = dohMock({}, { fail: ['dns.google', 'cloudflare-dns.com'] });
  const e = await lookupCrazyDomains('down.com', { fetchImpl: allDown.fetchImpl });
  assert.equal(e.detected, false);
  assert.match(e.error, /DNS lookup failed/);
});

test('isCrazyDomainsHosted caches successful lookups, not failures', async () => {
  const ok = dohMock({ 'cached.com': { NS: ['ns1.crazydomains.com'] } });
  await isCrazyDomainsHosted('www.cached.com', { fetchImpl: ok.fetchImpl });
  const n = ok.calls.length;
  const again = await isCrazyDomainsHosted('cached.com', { fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls.length, n, 'second lookup served from cache');
  assert.equal(hostingLabel(again), 'Crazy Domains (NS)');

  const down = dohMock({}, { fail: ['dns.google', 'cloudflare-dns.com'] });
  await isCrazyDomainsHosted('flaky.com', { fetchImpl: down.fetchImpl });
  const before = down.calls.length;
  await isCrazyDomainsHosted('flaky.com', { fetchImpl: down.fetchImpl });
  assert.ok(down.calls.length > before, 'failed lookup retried');
});
