/**
 * Small DOM helpers shared by the popup and the dashboard.
 * All scraped data goes in through textContent, never innerHTML.
 */

/**
 * Create an element.
 *
 * @param {string} tag
 * @param {Record<string, any>} [props] Attributes; `class`, `text`, `on*` handlers and `dataset` are special.
 * @param {...(Node|string|null|false|undefined)} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Only allow http(s) links from scraped data into href attributes. */
export function safeHref(url) {
  return /^https?:\/\//i.test(String(url || '')) ? url : null;
}

/**
 * Copy text to the clipboard. Falls back to execCommand when the async API
 * is unavailable.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0;top:0;left:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

let toastTimer;
/**
 * Show a short status message at the bottom of the page.
 *
 * @param {string} message
 */
export function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 1600);
}

/**
 * Copy button that confirms with a toast and a brief label change.
 *
 * @param {string} text
 * @param {{ label?: string, className?: string, ariaLabel?: string }} [opts]
 * @returns {HTMLButtonElement}
 */
export function copyButton(text, { label = 'Copy', className = 'btn btn-small', ariaLabel } = {}) {
  const btn = h('button', { type: 'button', class: className, 'aria-label': ariaLabel || `Copy ${text}`, text: label });
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyText(text);
    toast(ok ? `Copied ${text}` : 'Copy failed');
    if (ok) {
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = label), 1200);
    }
  });
  return btn;
}

const TAG_CLASS = {
  'likely owner': 'badge-owner',
  'store contact': 'badge-store',
  business: 'badge-business',
  'personal inbox': 'badge-personal',
  support: 'badge-support',
  'no-reply': 'badge-noreply',
};

/**
 * Pill for an email tag. Only "likely owner" uses the amber accent.
 *
 * @param {string} tag
 * @returns {HTMLElement}
 */
export function tagBadge(tag) {
  return h('span', { class: `badge ${TAG_CLASS[tag] || ''}`, text: tag });
}

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';

export const SOCIAL_ICONS = {
  instagram: `${SVG_OPEN}<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="0.6" fill="currentColor"/></svg>`,
  facebook: `${SVG_OPEN}<path d="M15.5 4.5H14a3 3 0 0 0-3 3V20M7.5 10.5h7"/></svg>`,
  tiktok: `${SVG_OPEN}<path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 4c.4 2.6 2.1 4.2 4.6 4.4"/></svg>`,
  linkedin: `${SVG_OPEN}<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M8 10.5V16M8 7.8v.1M11.5 16v-5.5M11.5 13c0-1.6 1-2.6 2.3-2.6s2.2.9 2.2 2.6V16"/></svg>`,
  x: `${SVG_OPEN}<path d="M5 5l14 14M19 5L5 19"/></svg>`,
  youtube: `${SVG_OPEN}<rect x="2.5" y="6" width="19" height="12" rx="3.5"/><path d="M10.5 9.5v5l4-2.5z" fill="currentColor"/></svg>`,
  pinterest: `${SVG_OPEN}<circle cx="12" cy="12" r="8.5"/><path d="M11 20l1.8-7.5M10.4 13.7c.5.8 1.3 1.2 2.3 1.2 2.1 0 3.4-1.8 3.4-4 0-2.3-1.8-3.9-4.2-3.9-2.6 0-4.2 1.8-4.2 3.8 0 .9.3 1.6.8 2"/></svg>`,
};

export const SOCIAL_LABELS = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  x: 'X',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
};

/**
 * Row of icon links for the socials that were found.
 *
 * @param {Record<string, string|null>} socials
 * @returns {HTMLElement|null} null when there are none.
 */
export function socialLinks(socials = {}) {
  const keys = Object.keys(SOCIAL_LABELS).filter((k) => safeHref(socials[k]));
  if (!keys.length) return null;
  const wrap = h('div', { class: 'socials' });
  for (const k of keys) {
    const a = h('a', {
      class: 'social',
      href: socials[k],
      target: '_blank',
      rel: 'noopener noreferrer',
      title: `${SOCIAL_LABELS[k]}: ${socials[k]}`,
      'aria-label': SOCIAL_LABELS[k],
    });
    a.innerHTML = SOCIAL_ICONS[k]; // static, trusted markup
    wrap.append(a);
  }
  return wrap;
}

/**
 * Hostname without "www." for display.
 *
 * @param {string} url
 * @returns {string}
 */
export function displayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
}
