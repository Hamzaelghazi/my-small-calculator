/**
 * content.js — injected into a Bing results page by background.js via
 * chrome.scripting.executeScript({ files: ['content.js'] }).
 *
 * It is NOT declared under "content_scripts" in the manifest: it only runs
 * when the harvester asks for it, never on your normal Bing browsing.
 *
 * executeScript() resolves with the value of the script's LAST expression,
 * so the whole file is a single IIFE whose return value is the result object:
 *
 *   {
 *     links:     string[]  // real destination URLs of organic results
 *     noResults: boolean   // Bing said "There are no results for …"
 *     captcha:   boolean   // Bing is showing a challenge / "unusual traffic"
 *     pageUrl:   string    // the URL that was actually scraped
 *   }
 */
(() => {
  'use strict';

  // Organic results only — ads, "People also ask", news carousels etc. live
  // outside `.b_algo`, so they are naturally excluded.
  const RESULT_LINK_SELECTOR = '#b_results .b_algo h2 a';

  /**
   * Bing frequently wraps result links in a click-tracking redirect:
   *   https://www.bing.com/ck/a?!&&p=…&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8&ntb=1
   * The real URL is in the `u` param: an "a1" prefix + URL-safe base64.
   * Without decoding, every link would look like bing.com and be filtered out.
   *
   * @param {string} href
   * @returns {string} the decoded destination URL (or the original href)
   */
  function decodeBingRedirect(href) {
    try {
      const url = new URL(href, location.href);
      const isBingRedirect =
        url.hostname.endsWith('bing.com') && url.pathname.startsWith('/ck/a');
      if (!isBingRedirect) return url.href;

      let encoded = url.searchParams.get('u');
      if (!encoded) return url.href;
      if (encoded.startsWith('a1')) encoded = encoded.slice(2);

      // URL-safe base64 -> standard base64, then pad to a multiple of 4.
      encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');
      while (encoded.length % 4) encoded += '=';

      // atob gives a binary string; decode it as UTF-8 so IDN/unicode paths survive.
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);

      return /^https?:\/\//i.test(decoded) ? decoded : url.href;
    } catch (err) {
      console.warn('[Bing Link Harvester] Could not decode link:', href, err);
      return href;
    }
  }

  /** True when Bing explicitly reports zero results for the query. */
  function detectNoResults() {
    if (document.querySelector('.b_no')) return true;
    const text = document.body ? document.body.innerText : '';
    return /There are no results for/i.test(text);
  }

  /**
   * True when Bing is blocking us with a challenge page.
   * The text check is only trusted when there are NO organic results, so a
   * query that happens to contain the word "captcha" isn't mistaken for one.
   *
   * @param {number} resultCount number of organic links found on the page
   */
  function detectCaptcha(resultCount) {
    // Known challenge markers / URLs.
    if (/\/turing\/|\/challenge/i.test(location.pathname)) return true;
    if (document.querySelector('#turingChallenge, iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"]')) {
      return true;
    }
    if (resultCount > 0) return false;

    const text = document.body ? document.body.innerText : '';
    return /captcha|unusual traffic|verify you are a human|solve the challenge/i.test(text);
  }

  // ---- Extract -------------------------------------------------------------
  const anchors = Array.from(document.querySelectorAll(RESULT_LINK_SELECTOR));
  const links = anchors
    .map((a) => a.getAttribute('href'))
    .filter(Boolean)
    .map(decodeBingRedirect);

  return {
    links,
    noResults: detectNoResults(),
    captcha: detectCaptcha(links.length),
    pageUrl: location.href,
  };
})();
