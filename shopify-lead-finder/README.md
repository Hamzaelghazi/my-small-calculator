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

1. Open any page of a store in your current tab.
2. Click the extension icon, then **Scan this store**.
3. The progress line shows each page as it's checked. A scan usually takes 2–10 seconds. Keep the popup open until it finishes.
4. The **best email** is shown large at the top with its tag. Click **Copy** to copy it.
5. Other emails are listed below with their score and tag. You'll also see the Shopify badge and `*.myshopify.com` domain, any phone numbers, and social profile links.
6. Click **Save lead** to add the store to your saved leads. When you reopen the popup on a store you've already saved, it shows the saved result, and **Scan again** refreshes it.

## Scan many stores (bulk scanner)

Click **Open bulk scanner** in the popup. It opens a full tab.

1. Paste store URLs into the box, one per line or comma separated. Bare domains (`brand.com`) are fine. Duplicates are removed, and the count under the box shows how many URLs are valid.
2. Pick your options:
   - **Stores at a time** (2, 4 or 6, default 4): how many stores are scanned in parallel.
   - **Shopify stores only**: non-Shopify results still show in the table but aren't saved.
   - **Skip stores already saved**: don't re-scan stores that are already in your saved leads. Uncheck it to refresh them.
3. Click **Start scan** (or press Ctrl/⌘ + Enter in the box). Rows appear as each store finishes. Click **Stop** to cancel. In-flight requests are aborted immediately.
4. Each finished store is **saved automatically**, so closing the tab loses nothing. Stores that failed (timeout, blocked, not found) are shown in the table but not saved.
5. In the results table, click a best email to copy it. Click the **+N** button to see every email found for that store.

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

CSV columns: Store Name, URL, Shopify, MyShopify Domain, Best Email, Best Email Tag, All Emails, Phones, Instagram, Facebook, TikTok, LinkedIn, X, YouTube, Pinterest, Status, Scanned At. The file is UTF-8 with a BOM, so Excel opens accented characters correctly.

## What gets checked

For each store, the scanner fetches:

- the homepage (redirects are followed, and the final address becomes the store's URL)
- `/pages/contact`, `/pages/contact-us`, `/policies/contact-information`, `/policies/privacy-policy`, `/policies/terms-of-service`, `/policies/refund-policy`, `/policies/shipping-policy`, `/pages/about`, `/pages/about-us`, `/pages/faq`
- up to 3 more links from the homepage whose address or text mentions contact, about, support or wholesale

Emails are found in plain text, in `mailto:` links, behind HTML entities and escapes (`&#64;`, `%40`, `@`), in Cloudflare-protected addresses, and in forms like `name [at] brand [dot] com`. Obvious junk is dropped: image filenames like `logo@2x.png`, placeholder domains (example.com, yourdomain.com), vendor domains (sentry, wixpress, shopify.com) and hash-like addresses.

Phone numbers come only from `tel:` links, because free-text numbers produce too many false matches.

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
- Each request times out after 12 seconds and reads at most about 2MB of a page.
- The popup scan stops if you close the popup. Use the bulk scanner for long lists.
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
│   ├── filters.js    email tag filter (tables + export)
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
