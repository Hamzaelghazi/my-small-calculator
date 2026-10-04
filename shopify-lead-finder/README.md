# Shopify Lead Finder

A Chrome extension (Manifest V3) for B2B prospecting. It finds the **publicly listed** contact emails, phone numbers and social profiles of Shopify stores, ranks which email is most likely to reach the owner, and exports leads to CSV.

It's plain HTML, CSS and vanilla JS (ES modules). There's no build step, no framework and no external libraries.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Arc).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `shopify-lead-finder` folder (the one containing `manifest.json`).
5. Pin the extension from the puzzle-piece menu so the icon is always visible.

After you edit any file, click the reload icon on the extension's card in `chrome://extensions`.

## Scan one store (popup)

Other ways to open the extension, if clicking the icon doesn't work:

- Press **Alt+Shift+L** on a store's page to open the popup. You can change the shortcut at `chrome://extensions/shortcuts`.
- Right-click the extension icon and choose **Options** to open the bulk scanner, then paste the store's URL.

1. Open any page of a store in your current tab.
2. Click the extension icon, then **Scan this store**.
3. The progress line shows each page as it's checked. A scan usually takes 2–10 seconds. Keep the popup open until it finishes.
4. The **best email** is shown large at the top with its tag. Click **Copy** to copy it.
5. Other emails are listed below with their score and tag. You'll also see the Shopify badge and `*.myshopify.com` domain, any phone numbers, and social profile links.
6. Click **Save lead** to add the store to your saved leads.
7. If you've scanned the store before, a notice at the top says so, with the date and whether it was saved ("Already scanned. Scanned Sep 29, 2026 · saved as a lead"). That works for stores you scanned but didn't save, too. **Scan again** refreshes it.

## Scan many stores (bulk scanner)

Click **Open bulk scanner** in the popup. It opens a full tab.

1. Paste store URLs into the box, one per line or comma separated. Bare domains (`brand.com`) are fine. Duplicates are removed, and the count under the box shows how many URLs are valid.
2. Pick your options:
   - **Stores at a time** (4, 10, 20 or 30, default 10): how many stores are scanned in parallel. 10 is safe. 20–30 is faster, but more stores may block you with "Blocked by the site (429)".
   - **Shopify stores only**: non-Shopify results still show in the table but aren't saved.
   - **Skip stores already scanned** (on by default): the extension remembers every store you scan, with the date, whether it was saved or not. Stores already scanned are skipped and listed under "N stores skipped: already scanned" with their dates. The count under the URL box warns you before you start. Uncheck it to scan them again; re-scanned rows are marked "Scanned before on …". Failed scans don't count, so they're always tried again. **Clear scan history** forgets the list. Saved leads are kept and still count as scanned.
3. Click **Start scan** (or press Ctrl/⌘ + Enter in the box). Rows appear as each store finishes. Click **Stop** to cancel. In-flight requests are aborted immediately.
4. Finished stores are **saved automatically** in batches every 1.5 seconds, so closing the tab loses at most the last couple of seconds. Stores that failed (timeout, blocked, not found) are shown in the table but not saved.
5. When the run ends, **Retry failed (N)** scans the stores that timed out or were blocked again. Try it a few minutes later, or at a lower speed.
6. In the results table, click a best email to copy it. Click the **+N** button to see every email found for that store.

### Scanning 1000+ stores

Paste the whole list, or click **Load from file (.txt, .csv)**. A file import picks out every web address and domain and ignores everything else, such as names, numbers, headers and email addresses, so you can load an exported spreadsheet as it is.

- **All at once:** under **Stores at a time**, choose **All at once** to start every store in the list together. Behind the scenes, at most 60 requests are on the network at a time. That keeps Chrome responsive and makes stores (most share Shopify's servers) less likely to block you. Each request's 12-second timeout only starts once it's actually sent. You can also pick 10, 30 or 100 stores at a time.
- **Quick scan:** checks only the homepage, `/pages/contact` and `/policies/contact-information`, plus the catalog data for the size estimate. That's about 5 requests per store instead of about 16, roughly 3× faster, though it finds slightly fewer emails. In a local test, 1000 stores took about 40 seconds with Quick scan and about 110 seconds with the full scan. Real stores are slower: expect a few minutes for a Quick scan of 1000 and 10–20 minutes for a full one.
- **Leave the tab open.** It can be in the background, but don't let the computer sleep. The progress line shows done, failed and time left.
- **Resume:** your URL list, speed and Quick scan choice are remembered, and **Skip stores already scanned** is on by default. If the tab closes, open the bulk scanner again and press **Start scan**.
- **Blocked stores:** with very large runs, some stores may answer "Blocked by the site (429)". Use **Retry failed** afterwards, or pick a lower speed.
- **Storage:** the extension has unlimited local storage. The saved-leads table shows the newest 300. Search to find others. Export CSV and Copy all best emails always include every matching lead.

### Email filter

The **Email filter** bar controls which emails count, in both tables and in everything you copy or export.

- Click a tag to switch it on or off. Stores with no email carrying a selected tag are hidden, and the page says how many.
- The best email is picked again from the emails that pass the filter, so **Copy all best emails** and **Export CSV** only give you addresses with the tags you chose. The CSV's "All Emails" column is filtered too.
- Presets: **All emails**, **Owner-focused** (likely owner + store contact) and **Outreach-ready** (everything except support and no-reply).
- Your choice is remembered next time you open the bulk scanner.

### Saved leads

The lower section lists every saved lead, including ones saved from the popup.

- **Search** filters by store name, URL or any email.
- **Export CSV** downloads `shopify-leads-YYYY-MM-DD.csv`. When a search or the email filter is active, only the matching leads and emails are exported, and the button shows the count.
- **Copy all best emails** copies the best email from each visible lead, one per line.
- **Delete** removes one lead. **Clear all** removes all of them after you confirm.

CSV columns: Store Name, URL, Shopify, MyShopify Domain, Best Email, Best Email Tag, Best Phone, All Emails, Phones, WhatsApp, Instagram, Facebook, TikTok, LinkedIn, X, YouTube, Pinterest, Est. Monthly Sales, Store Size, Suggested Offer, Products, Median Price, Tech Stack, Status, First Scanned, Scanned At. There's one row per store, so a store never appears twice even if you scan it again. The file is UTF-8 with a BOM, so Excel opens accented characters correctly.

## Only Crazy Domains hosted stores

Turn on **Only show Crazy Domains hosted stores**, either in the popup (under the store name) or in the bulk scanner options. The two share one setting. When it's on, each store's DNS is checked before the page scan:

1. **Nameservers (NS):** a match on `crazydomains.com`, `syrahost.com`, `premium.exchange` or `dnspackage.com` gives **Crazy Domains (NS)**.
2. If no nameserver matched, **mail servers (MX):** a match on `ds.network`, `crazydomains` or `xion.oxcs.net` gives **Crazy Domains (MX)**.

Matching stores are scanned as usual and show the badge next to the store name (hover it to see the matched server). The match is also in the CSV's **DNS Host** column. Other stores are skipped, and the progress line counts them ("4 not on Crazy Domains"). If both DNS resolvers fail for a store, it's skipped too ("1 DNS check failed"), and the rest of the run continues.

How it works:

- DNS is read over HTTPS from Google (`dns.google`), with Cloudflare (`cloudflare-dns.com`) as a fallback, using an 8-second timeout. This sends each store's domain name to that resolver.
- NS records live on the main domain, so `www.` is dropped, and a subdomain like `shop.brand.com.au` falls back to `brand.com.au`.
- Results are cached in `chrome.storage.local` for 24 hours, so a domain is looked up only once. Failed lookups aren't cached, so they're retried next time.
- Non-matching stores aren't added to the scan history, so turning the toggle off later lets you scan them normally.

## Estimated sales and suggested offer

Every Shopify store gets a **store size** with an estimated monthly sales range and a suggested offer level, so you can match your offer to the prospect. It's shown in the popup ("Estimated size"), in both dashboard tables ("Est. sales"; hover for the signals), and in the CSV.

**This is a rough estimate, not real sales data.** No store publishes its revenue. The estimate adds up public signals:

| Signal | Points |
| --- | --- |
| Products in the catalog (from `/meta.json`): 10+ / 50+ / 200+ / 1000+ | +1 / +2 / +3 / +4 |
| Median product price (from `/products.json`): $50+ / $150+ | +1 / +2 |
| 5+ products updated in the last 30 days | +1 |
| Premium apps: Attentive, Postscript, Yotpo, Okendo, Gorgias, Rebuy, Recharge | +1 each, up to +4 |
| Email marketing (Klaviyo, Omnisend) | +1 |
| Reviews app (Judge.me, Loox, Stamped) | +1 |
| Ad pixels (Meta, TikTok, Google Ads, Pinterest, Snap) | +1 each, up to +2 |
| Buy now, pay later (Klarna, Afterpay, Affirm, Sezzle) | +1 |
| Ships to 10+ / 50+ countries | +1 / +2 |
| 3+ social profiles | +1 |

| Score | Store size | Est. monthly sales | Suggested offer |
| --- | --- | --- | --- |
| 0–3 | Early | under $5k | Starter offer (low-ticket, DIY) |
| 4–6 | Small | $5k–$25k | Growth offer (entry package) |
| 7–9 | Mid-size | $25k–$100k | Core offer (done-for-you) |
| 10–12 | Large | $100k–$500k | Premium offer (monthly retainer) |
| 13+ | Enterprise | $500k+ | Enterprise offer (custom scope) |

Use the **Store size** row in the dashboard filter to show and export only the sizes that fit one offer. For example, switch on only Mid-size and Large, then Export CSV. Leads that are "Unknown" have no estimate: they aren't Shopify stores, the scan failed or was password protected, or they were saved before this feature (scan them again to add it).

Treat it as a way to sort a list, and check a store yourself before pitching a high-ticket offer. A store with a small catalog can still sell a lot, and a big catalog doesn't always mean big sales. Prices are in the store's own currency.

## What gets checked

For each store, the scanner fetches:

- the homepage (redirects are followed, and the final address becomes the store's URL)
- `/pages/contact`, `/pages/contact-us`, `/policies/contact-information`, `/policies/privacy-policy`, `/policies/terms-of-service`, `/policies/refund-policy`, `/policies/shipping-policy`, `/pages/about`, `/pages/about-us`, `/pages/faq`
- up to 3 more links from the homepage whose address or text mentions contact, about, support or wholesale
- with the Crazy Domains toggle on: the domain's NS and MX records, via DNS-over-HTTPS
- for Shopify stores: `/meta.json` and `/products.json?limit=100` (public catalog data, for the size estimate)

Emails are found in plain text, in `mailto:` links, behind HTML entities and escapes (`&#64;`, `%40`, `@`), in Cloudflare-protected addresses, and in forms like `name [at] brand [dot] com`. Obvious junk is dropped: image filenames like `logo@2x.png`, placeholder domains (example.com, yourdomain.com), vendor domains (sentry, wixpress, shopify.com) and hash-like addresses.

Phone numbers come from four places, most reliable first:

1. **Call links** (`tel:`) on any page.
2. **Site data**: the `telephone` field in the store's schema.org data.
3. **WhatsApp** links (`wa.me/…`, `api.whatsapp.com/send?phone=…`), marked "WhatsApp".
4. **Page text**, only when the number follows a label such as "Phone:", "Tel", "Call us at", "Mobile" or "WhatsApp". Unlabelled numbers are ignored, because order numbers, dates and years cause false matches.

The same number found in several places is merged, keeping the version with the country code. The first one is marked **best to call**. It's shown right under the best email in the popup, in a Phone column in both dashboard tables (click to call), and in the CSV.

For cold-call lists, switch on **Has phone number** in the dashboard filter, then Export CSV.

## Email scores and tags

Each email gets a score. The highest is shown as the best email.

| Signal | Points |
| --- | --- |
| On the store's own domain | +3 |
| Local part is owner, founder, ceo, or the store's name | +3 |
| info, contact, hello, sales, wholesale, partnerships, business | +2 |
| Personal inbox (Gmail, Outlook, Hotmail, Yahoo, iCloud, Proton…) | +2 |
| support, help, care, service, orders | +1 |
| Found on a contact page | +1 |
| Found on `/policies/contact-information` (the store email from Shopify settings) | +2 |
| Found on another `/policies/` page (instead of the +2 above) | +1 |
| noreply, no-reply, donotreply, mailer-daemon | −5 |

| Tag | Meaning |
| --- | --- |
| **likely owner** (amber) | Named like an owner (owner@, founder@, ceo@) or after the store itself (glowbrand@gmail.com). Your best shot at a decision maker. |
| **store contact** | Found on the store's Shopify policy pages. Shopify fills `/policies/contact-information` and its generated policy templates from the store email set in the admin settings, so this is usually the inbox the owner registered with Shopify. |
| **business** | A general business inbox (info@, hello@, sales@, wholesale@) or a named address on the store's domain. Usually read by the owner on small stores. |
| **personal inbox** | A Gmail, Outlook, iCloud or similar address. On small stores this is often the owner directly. |
| **support** | A customer service inbox (support@, help@, orders@). Monitored, but it may be a team or an outsourced help desk. |
| **no-reply** | A no-reply address. Kept in the list for completeness but never chosen as the best email. |

### About the Shopify "notification" email

The sender and notification emails in a store's Shopify admin are private. No public page or API exposes them, and this extension doesn't try to get them. The **store contact** tag is the closest public equivalent: the email the store chose to publish on its Shopify contact-information and policy pages.

Leads saved by an earlier version are re-scored automatically with the current rules, so they get the store contact tag without a re-scan.

## Known limits

- **Only public information.** The scanner reads the same pages any visitor sees. It doesn't guess addresses, query third-party databases or get past logins.
- **Emails loaded by JavaScript after the page renders** (some contact-form apps and chat widgets) aren't seen, because pages are fetched as raw HTML rather than rendered.
- **Contact forms without a listed email** will show "No public email found". Use the contact page or Instagram DM instead.
- **Bot protection** (Cloudflare challenges, rate limits) can block a scan. It shows up as "Blocked by the site". Lower the concurrency and try again later.
- **Password-protected stores** (not launched yet) show as "Store password protected". Only the password page is checked.
- **Headless or custom storefronts** (Hydrogen and similar) may not carry the usual Shopify markers, so they can show as "Not Shopify".
- Sales estimates are guesses from public signals, not revenue data. Some stores block `/products.json`, which lowers the confidence.
- Each request times out after 12 seconds and reads at most about 2MB of a page.
- The popup scan stops if you close the popup. Use the bulk scanner for long lists.
- The bulk scan stops if you close the dashboard tab or the computer sleeps. Press Start again to resume.
- Leads live in `chrome.storage.local` on this computer only. Export CSV to back them up.

Respect privacy and anti-spam law (GDPR, CAN-SPAM, CASL) when you contact the people you find. Send relevant, one-to-one B2B outreach with a clear opt-out.

## Development

```
shopify-lead-finder/
├── manifest.json
├── popup.html / popup.css / popup.js        current-tab scanner
├── dashboard.html / dashboard.css / dashboard.js   bulk scanner + saved leads
├── lib/
│   ├── scanner.js    scanning, extraction, scoring (no DOM, runs in Node too)
│   ├── storage.js    chrome.storage.local helpers
│   ├── csv.js        CSV export
│   ├── filters.js    email tag, store size and phone filters (tables + export)
│   ├── dns.js        DNS-over-HTTPS (NS/MX) and the Crazy Domains check
│   ├── history.js    "already scanned" lookups from saved leads + scan history
│   ├── sales.js      store size / sales estimate from public signals
│   ├── ui.js         shared DOM helpers and icons
│   └── theme.css     shared design tokens (light + dark)
├── icons/            16, 32, 48, 128 px
├── test/scanner.test.mjs
└── tools/make-icons.mjs
```

Run the tests (Node 18+, no install needed):

```sh
cd shopify-lead-finder
npm test
```

Regenerate the icons with `npm run icons`. The `package.json` only exists so Node treats the files as ES modules. Chrome ignores it.
