# Bing Link Harvester (Chrome extension, Manifest V3)

Takes a list of Bing queries and collects every organic result URL from every
paginated results page, one query after another. The output is a deduplicated
plain-text list of URLs, plus a one-column CSV export (`url`).

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `bing-link-harvester/` folder.
3. Pin the extension and click its icon.

## Use

1. Paste queries into the popup, one per line.
2. Click **Start Harvest**, then **leave the popup open**. The popup keeps the service worker alive.
   Or click **⤢ Full page** to run the harvester in a normal browser tab. That tab doesn't close when you click away, which is the easier way to run long harvests.
3. When it finishes, click **Copy All Links** or **Export CSV**.

If you close the popup partway through, reopen it and the harvest picks up where it stopped (progress is saved in `chrome.storage.local`).

### CAPTCHA

If Bing shows a challenge, the harvest pauses, an alert appears and the toolbar badge shows a red `!`.
Click **Show Bing tab** and solve the challenge (switching tabs closes the popup), then reopen the popup and click **Resume**. The same page is tried again.

## Keeping results on-target

On automated searches, Bing often ignores operators (`ip:`, `site:`, quoted terms) or rewrites the query. It then returns pages that have nothing to do with what you asked for. The **Options** panel guards against this:

- **Enforce `site:` operator**: drops any result whose domain doesn't match the query's `site:` / `-site:` operators. If two pages in a row contain only off-target results, the harvester decides Bing is ignoring `site:` and moves to the next query.
- **Skip query if Bing changes it**: if Bing shows "Including results for…" or "Did you mean…", or its search box holds a different query from yours, nothing is collected for that query.
- **Bing market**: **Auto** turns `loc:AU` into `&cc=AU` on the request. You can also pick a market such as `en-AU`.

The activity log shows what was dropped and why.

## How it works

| File | Role |
| --- | --- |
| `background.js` | Queue and pagination loop, link cleaning, persistence, single-tab management |
| `content.js` | Injected on demand. Reads `#b_results .b_algo h2 a`, decodes Bing's `/ck/a` redirect links and returns `{ links, noResults, captcha }` |
| `popup.html/js` | UI, keep-alive port, copy and CSV export |

Pages are fetched at `https://www.bing.com/search?q=QUERY&first=N` with `N = (page-1)*10 + 1`, waiting 3 s between pages.
A query ends when any of these happens:

- Bing shows "no results"
- the page has no organic results
- the page contains no links that weren't seen earlier for that query (Bing is repeating itself)
- the query reaches 50 pages

If a page fails to load, it is skipped. After 3 failures in a row, the whole query is skipped.

To change the blocked domains or the timing, edit `BLOCKED_DOMAINS` and `CONFIG` at the top of `background.js`.
