// Helium-style !bangs for Vivaldi.
//
// Re-implements the behaviour of Helium's native bangs
// (https://github.com/imputnet/helium) as a Vivaldi UI mod: type `!gh react`,
// `react !gh` or `react !gh hooks` in the address bar and the query goes
// straight to the site, never through the default search engine.
//
// Bang data: Helium services `/bangs.json` (Kagi bangs, MIT licensed).
// Loaded into Vivaldi's window.html by install.ps1.

(() => {
'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  // Equivalent of Helium's "Allow downloading the !bangs list" toggle.
  // When false, no list is fetched and bangs do nothing.
  enabled: true,
  // Equivalent of Helium's "Use your own instance of Helium services".
  // The list is fetched from `${servicesOrigin}/bangs.json`.
  servicesOrigin: 'https://services.helium.imput.net',
  // How long a downloaded list is reused before it is fetched again.
  refreshHours: 24,
  // Maximum number of bang suggestions shown while typing `!prefix`.
  maxSuggestions: 3,
};

// ---------------------------------------------------------------------------
// Pure logic (no DOM; exported for tests at the bottom of the file)
// ---------------------------------------------------------------------------

const CATEGORY_OTHER = 0;
const CATEGORY_AI = 1;

// Flag bits written by helium-services' mkbangs.mjs.
const FLAG_OPEN_BASE_PATH = 1 << 0;

const isSpace = (c) => /\s/.test(c);

// bangs.json is JSON with `//` comments and trailing commas. Strip both while
// leaving string contents (which contain `//` in every URL) untouched.
function stripJsonExtensions(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ',') {
      let j = i + 1;
      while (j < n && isSpace(text[j])) j++;
      if (text[j] !== ']' && text[j] !== '}') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const isHttpUrl = (template) => {
  try {
    const u = new URL(template.replaceAll('{searchTerms}', 'x'));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

// Mirrors Helium's ParseManifest: an array of {s, ts, u, sc?, f?}; every
// trigger in `ts` becomes its own bang. Malformed entries are skipped.
function parseManifest(text) {
  const parsed = JSON.parse(stripJsonExtensions(text));
  if (!Array.isArray(parsed)) throw new Error('bang data is not an array');
  const bangs = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { s: name, ts: triggers, u: url, sc, f } = entry;
    if (typeof name !== 'string' || !name || !Array.isArray(triggers) ||
        typeof url !== 'string' || !isHttpUrl(url)) {
      continue;
    }
    for (const trigger of triggers) {
      if (typeof trigger !== 'string' || !trigger) continue;
      bangs.push({
        trigger: trigger.toLowerCase(),
        name,
        url,
        category: sc === 'ai' ? CATEGORY_AI : CATEGORY_OTHER,
        flags: typeof f === 'number' ? f : 0,
      });
    }
  }
  return bangs;
}

class Catalogue {
  // `reserved` holds keywords already owned by the user's search engines;
  // like Helium, a user keyword always wins over a bang with the same name.
  constructor(bangs, reserved = new Set()) {
    this.byTrigger = new Map();
    for (const bang of bangs) {
      if (this.byTrigger.has(bang.trigger) || reserved.has('!' + bang.trigger)) continue;
      this.byTrigger.set(bang.trigger, bang);
    }
    // Shortest first, then alphabetical: the order suggestions are shown in.
    this.sorted = [...this.byTrigger.keys()].sort(
        (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
  }

  get size() { return this.byTrigger.size; }

  // `keyword` includes the leading "!".
  lookup(keyword) {
    if (keyword.length < 2 || keyword[0] !== '!') return null;
    return this.byTrigger.get(keyword.slice(1).toLowerCase()) ?? null;
  }

  suggest(prefix, limit) {
    const p = prefix.toLowerCase();
    const out = [];
    for (const t of this.sorted) {
      if (t.startsWith(p)) {
        out.push(this.byTrigger.get(t));
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}

// Mirrors AutocompleteInput::SplitKeywordFromInput as patched by Helium:
// a bang may lead the input (`!gh react`), or appear later as its own
// whitespace-preceded token (`react !gh`, `react !gh hooks`). Returns the
// keyword and the query with the bang removed, or null.
function splitBang(input) {
  const text = input.replace(/^\s+/, '');
  if (!text) return null;

  const firstEnd = text.search(/\s/);
  const first = firstEnd < 0 ? text : text.slice(0, firstEnd);
  if (first.startsWith('!') && first.length > 1) {
    const rest = firstEnd < 0 ? '' : text.slice(firstEnd).replace(/^\s+/, '');
    return { keyword: first, query: rest };
  }

  const m = /\s(![^\s]+)/.exec(text);
  if (!m) return null;
  const start = m.index + 1;
  const end = start + m[1].length;
  // Remove the bang and one adjoining space, as Helium does.
  let query = text.slice(0, start);
  query = end < text.length ? query + text.slice(end + 1) : query.slice(0, -1);
  return { keyword: m[1], query: query.replace(/^\s+/, '') };
}

// Finds a known bang in `input`. A leading token that isn't a known bang
// doesn't hide a known bang later in the text.
function findBang(input, catalogue) {
  const split = splitBang(input);
  if (!split) return null;
  let bang = catalogue.lookup(split.keyword);
  if (bang) return { bang, keyword: split.keyword, query: split.query };

  // `!notabang foo !gh` — try the later tokens too.
  const text = input.replace(/^\s+/, '');
  const re = /\s(![^\s]+)/g;
  for (let m; (m = re.exec(text));) {
    bang = catalogue.lookup(m[1]);
    if (!bang) continue;
    const start = m.index + 1;
    const end = start + m[1].length;
    let query = text.slice(0, start);
    query = end < text.length ? query + text.slice(end + 1) : query.slice(0, -1);
    return { bang, keyword: m[1], query: query.replace(/^\s+/, '') };
  }
  return null;
}

// Mirrors TemplateURLRef's search-term escaping: terms after the `?` are
// query-escaped with `+` for spaces; terms before it are path-escaped.
function encodeTerms(terms, inQuery) {
  const encoded = encodeURIComponent(terms);
  if (inQuery) return encoded.replace(/%20/g, '+');
  return encoded.replace(/%(2F|3A|40|24|26|2B|2C|3B|3D)/gi,
                         (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function buildUrl(bang, query) {
  const terms = query.trim();
  if (!terms) {
    // A bare bang opens the site itself rather than an empty search.
    const u = new URL(bang.url.replaceAll('{searchTerms}', ''));
    if (bang.flags & FLAG_OPEN_BASE_PATH) return u.origin + u.pathname;
    return u.origin + '/';
  }
  const queryStart = bang.url.indexOf('?');
  const inQuery = queryStart >= 0 && bang.url.indexOf('{searchTerms}') > queryStart;
  return bang.url.replaceAll('{searchTerms}', encodeTerms(terms, inQuery));
}

// Replicates Vivaldi's address-bar open options so modifiers behave exactly
// as they do for normal Enter: Shift = new tab, Ctrl = background tab,
// Ctrl+Shift = new window, Ctrl+Shift+Alt = private window, plus the
// "open in new tab" shortcut preference (Alt or Shift).
function openOptions({ ctrlKey, altKey, shiftKey }, openShortcut, incognito) {
  const o = { inCurrent: true, inBackground: false, inNewWindow: false, incognito: false };
  if (shiftKey && ctrlKey && altKey) {
    o.inNewWindow = true;
    o.incognito = true;
  } else if (shiftKey && ctrlKey) {
    o.inNewWindow = true;
  } else if (shiftKey && !altKey) {
    o.inCurrent = false;
  } else if (ctrlKey && !shiftKey && !altKey) {
    o.inCurrent = false;
    o.inBackground = true;
  }
  if ((shiftKey && openShortcut === 'shift') || (altKey && openShortcut === 'alt')) {
    o.inCurrent = false;
    o.inBackground = !!ctrlKey;
  }
  o.incognito = incognito;
  o.fromUrlField = true;
  return o;
}

const core = {
  CONFIG, CATEGORY_AI, CATEGORY_OTHER, stripJsonExtensions, parseManifest,
  Catalogue, splitBang, findBang, encodeTerms, buildUrl, openOptions,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = core;
  return;
}

// ---------------------------------------------------------------------------
// Bang list loading (cached in IndexedDB, shared by all windows)
// ---------------------------------------------------------------------------

const DB_NAME = 'helium-bangs';
const STORE = 'kv';
const CACHE_KEY = 'catalogue';
const LOG = '[helium-bangs]';

// Helium's retry policy: 5s, doubling, 20% jitter, capped at 5 minutes.
const RETRY = { initial: 5000, factor: 2, jitter: 0.2, max: 300000 };

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

const readCache = () => idb('readonly', (s) => s.get(CACHE_KEY)).catch(() => null);
const writeCache = (value) => idb('readwrite', (s) => s.put(value, CACHE_KEY)).catch(() => {});

async function download(origin) {
  const url = new URL('/bangs.json', origin).href;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (res.status !== 200 || mime !== 'application/json') {
      throw new Error(`fetching bangs failed: status ${res.status}, type ${mime}`);
    }
    const text = await res.text();
    if (text.length > 5_000_000) throw new Error('bang data too large');
    return parseManifest(text);
  } finally {
    clearTimeout(timer);
  }
}

class BangLoader {
  constructor(onCatalogue) {
    this.onCatalogue = onCatalogue;
    this.delay = RETRY.initial;
    this.timer = null;
    this.disposed = false;
  }

  async start() {
    if (!CONFIG.enabled) return;
    const cached = await readCache();
    const usable = cached && cached.origin === CONFIG.servicesOrigin && Array.isArray(cached.bangs);
    if (usable) this.onCatalogue(cached.bangs);
    const stale = !usable || Date.now() - cached.fetchedAt > CONFIG.refreshHours * 3600e3;
    if (stale) this.fetch();
  }

  async fetch() {
    if (this.disposed) return;
    try {
      // Only one window downloads; the others find a fresh cache afterwards.
      const bangs = await navigator.locks.request(DB_NAME, async () => {
        const cached = await readCache();
        if (cached && cached.origin === CONFIG.servicesOrigin &&
            Date.now() - cached.fetchedAt < CONFIG.refreshHours * 3600e3) {
          return cached.bangs;
        }
        const fresh = await download(CONFIG.servicesOrigin);
        await writeCache({ origin: CONFIG.servicesOrigin, fetchedAt: Date.now(), bangs: fresh });
        return fresh;
      });
      this.delay = RETRY.initial;
      if (!this.disposed) this.onCatalogue(bangs);
    } catch (err) {
      console.error(LOG, err);
      const jitter = 1 - RETRY.jitter * Math.random();
      this.timer = setTimeout(() => this.fetch(), this.delay * jitter);
      this.delay = Math.min(this.delay * RETRY.factor, RETRY.max);
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}

// ---------------------------------------------------------------------------
// Address bar integration
// ---------------------------------------------------------------------------

const INPUT_ID = 'urlFieldInput';
const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

// Motion tokens, shared by the CSS and the Web Animations below.
const MOTION = {
  fast: 120,
  normal: 220,
  stagger: 30,
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
};

// Horizontal inset of the token text inside the chip; the morph lines the
// typed `!gh` up with this so the text appears to slide into the chip.
const CHIP_TOKEN_INSET = 4;

const AI_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2.5 2.75h5a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v8.69l1.47-1.47a.75.75 0 0 1 .53-.22h8.25a.25.25 0 0 0 .25-.25V9a.75.75 0 0 1 1.5 0v2.25c0 .97-.78 1.75-1.75 1.75H4.56l-2.28 2.28A.75.75 0 0 1 1 14.75V4.5c0-.97.78-1.75 1.75-1.75zM12 1c.18 1.55 1.45 2.82 3 3-1.55.18-2.82 1.45-3 3-.18-1.55-1.45-2.82-3-3 1.55-.18 2.82-1.45 3-3z"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M5 5l6 6m0-6l-6 6"/></svg>';

const STYLE = `
:root {
  --hb-dur-fast: ${MOTION.fast}ms;
  --hb-dur: ${MOTION.normal}ms;
  --hb-ease: ${MOTION.ease};
}

/* Keyword chip ----------------------------------------------------------- */
.hb-chip {
  --hb-accent: var(--hb-tint, var(--colorHighlightBg, #3d7bd9));
  position: relative; z-index: 1;
  display: inline-flex; flex: none; align-items: center; align-self: center;
  box-sizing: border-box; height: 20px; max-width: 45%;
  margin: 0 3px 0 4px; padding: 0 8px 0 5px;
  border-radius: min(calc(var(--radius, 6px) / 2), 10px);
  background: color-mix(in srgb, var(--hb-accent) 22%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hb-accent) 42%, transparent);
  color: var(--colorFg, inherit);
  font-size: 12px; white-space: nowrap; cursor: default;
}
.hb-chip-body { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.hb-chip-icon { position: relative; display: grid; place-items: center; flex: none; width: 14px; height: 14px; }
.hb-chip-icon > * { grid-area: 1 / 1; width: 14px; height: 14px; }
.hb-chip-icon > img, .hb-chip-icon > svg { transition: opacity var(--hb-dur-fast) ease; }
.hb-chip-close {
  display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%;
  background: color-mix(in srgb, var(--colorFg, #fff) 20%, transparent);
  color: inherit; opacity: 0; cursor: pointer;
  transition: opacity var(--hb-dur-fast) ease;
}
.hb-chip-close svg { width: 10px; height: 10px; }
.hb-chip:hover .hb-chip-close { opacity: 1; }
.hb-chip:hover .hb-chip-icon > :not(.hb-chip-close) { opacity: 0; }
.hb-chip-label { overflow: hidden; text-overflow: ellipsis; }
.hb-ai .hb-chip-label {
  background-image: linear-gradient(100deg, var(--colorFg, #fff) 36%,
      color-mix(in srgb, var(--hb-accent) 70%, var(--colorFg, #fff)) 50%, var(--colorFg, #fff) 64%);
  background-size: 300% 100%; background-position: 100% 0;
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.hb-chip-token {
  position: absolute; left: ${CHIP_TOKEN_INSET}px; top: 0;
  line-height: 20px; white-space: pre; opacity: 0; pointer-events: none;
}

/* Recognised bang in the text (drawn behind the input's glyphs) ---------- */
.hb-token {
  position: absolute; z-index: 0; height: 20px; pointer-events: none;
  border-radius: 5px;
  background: color-mix(in srgb, var(--hb-tint, var(--colorHighlightBg, #3d7bd9)) 24%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hb-tint, var(--colorHighlightBg, #3d7bd9)) 45%, transparent);
}

/* Dropdown --------------------------------------------------------------- */
.OmniDropdown[data-hb-hide-first] > ul:not(.hb-rows) > li[data-index="0"] { display: none; }
.hb-rows { margin: 0; padding: 0; }
.hb-rows .OmniLinkItem svg { width: 16px; height: 16px; }
.hb-rows .OmniLinkItem:not(.OmniLinkItem--Highlighted):hover {
  background: color-mix(in srgb, var(--colorHighlightBg, #3d7bd9) 20%, transparent);
}
.hb-rows .hb-dim, .hb-rows .hb-domain { opacity: .6; }
.OmniLinkItem-Badge.hb-key {
  padding: 1px 5px; border-radius: 4px;
  font-family: Consolas, 'Cascadia Mono', ui-monospace, monospace; font-size: 11px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, currentColor 32%, transparent);
}
.hb-key b { font-weight: 700; }
.hb-key .hb-rest { opacity: .7; }
.hb-footer {
  display: flex; justify-content: flex-end; gap: 14px;
  margin-top: 3px; padding: 4px 12px 5px;
  border-top: 1px solid color-mix(in srgb, var(--colorFg, #888) 12%, transparent);
  font-size: 11px; opacity: .7;
}
.hb-footer kbd {
  margin-right: 5px; padding: 0 4px; border-radius: 3px;
  font: inherit; font-family: Consolas, 'Cascadia Mono', ui-monospace, monospace;
  background: color-mix(in srgb, currentColor 14%, transparent);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, currentColor 30%, transparent);
}
.hb-motion .OmniDropdown:has(.hb-rows) .OmniLinkItem {
  transition: background-color var(--hb-dur-fast) ease, color var(--hb-dur-fast) ease;
}

.hb-ghost { position: fixed; margin: 0; pointer-events: none; z-index: 2147483647; max-width: none; }
.hb-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;

const bangOrigin = (bang) => new URL(bang.url.replaceAll('{searchTerms}', '')).origin;
const bangDomain = (bang) => new URL(bangOrigin(bang)).hostname.replace(/^www\./, '');

// Icons come from the local favicon database only (sites you have visited);
// suggestions never cause requests to the bang's site.
const faviconUrl = (bang, size) =>
  `chrome://favicon2/?size=${size}&pageUrl=${encodeURIComponent(bangOrigin(bang) + '/')}`;
const faviconSrcset = (bang) => [16, 24, 32].map((s) => `${faviconUrl(bang, s)} ${s}w`).join(',');

function bangIcon(bang) {
  if (bang.category === CATEGORY_AI) {
    const span = document.createElement('span');
    span.innerHTML = AI_ICON;
    return span.firstChild;
  }
  const img = document.createElement('img');
  img.width = img.height = 16;
  img.setAttribute('aria-hidden', 'true');
  img.srcset = faviconSrcset(bang);
  return img;
}

// "Search GitHub", or "Ask ChatGPT" for AI chatbots (Helium's AI category).
const actionLabel = (bang) => (bang.category === CATEGORY_AI ? 'Ask ' : 'Search ') + bang.name;
const emptyLabel = (bang) => (bang.category === CATEGORY_AI ? 'Type a question' : 'Type search term');

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// Brand colour of a favicon: the saturation-weighted average of its vivid
// pixels, or null for grey/monochrome icons (which then use the theme colour).
function dominantColor(img) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let r = 0, gr = 0, b = 0, weight = 0, opaque = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    opaque++;
    const max = Math.max(d[i], d[i + 1], d[i + 2]);
    const min = Math.min(d[i], d[i + 1], d[i + 2]);
    if (max < 50) continue;
    const sat = (max - min) / max;
    const w = sat * sat;
    r += d[i] * w; gr += d[i + 1] * w; b += d[i + 2] * w; weight += w;
  }
  if (!opaque || weight / opaque < 0.08) return null;
  return `rgb(${Math.round(r / weight)} ${Math.round(gr / weight)} ${Math.round(b / weight)})`;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Index of `token` as a whole word in `text`, case-insensitively.
function tokenIndex(text, token) {
  const m = new RegExp('(^|\\s)(' + escapeRegExp(token) + ')(?=\\s|$)', 'i').exec(text);
  return m ? m.index + m[1].length : -1;
}

function findController(input) {
  const key = Object.keys(input).find((k) => k.startsWith('__reactFiber'));
  for (let f = key && input[key]; f; f = f.return) {
    if (f.stateNode && typeof f.stateNode._urlFieldGo === 'function') return f.stateNode;
  }
  return null;
}

class AddressBarBangs {
  constructor() {
    this.catalogue = null;
    this.reserved = new Set();
    this.rawBangs = null;
    // Keyword mode is per tab, like Chromium's, keyed by Vivaldi page id.
    this.chips = new Map();
    this.openShortcut = 'alt';
    this.incognito = false;
    this.renderQueued = false;
    this.observer = new MutationObserver(() => this.queueRender());
    this.observed = null;
    this.cleanups = [];

    // Motion follows Vivaldi's "Use animation" setting and the OS setting.
    this.useAnimation = true;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.motion = false;
    this.anims = new Set();
    this.tints = new Map();
    this.measure = document.createElement('canvas').getContext('2d');

    this.loader = new BangLoader((bangs) => {
      this.rawBangs = bangs;
      this.rebuild();
    });
  }

  start() {
    const style = el('style');
    style.id = 'helium-bangs-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
    this.live = el('div', 'hb-sr');
    this.live.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.live);
    this.cleanups.push(() => { style.remove(); this.live.remove(); });

    this.listen(window, 'keydown', (e) => this.onKeyDown(e), true);
    this.listen(window, 'input', (e) => e.target?.id === INPUT_ID && this.queueRender(), true);
    this.listen(window, 'scroll', (e) => e.target?.id === INPUT_ID && this.queueRender(), true);
    this.listen(window, 'focusin', (e) => e.target?.id === INPUT_ID && this.queueRender(), true);
    this.listen(window, 'focusout', (e) => e.target?.id === INPUT_ID && this.onBlur(e.target), true);
    this.listen(this.reducedMotion, 'change', () => this.updateMotion());

    const onActivated = () => this.queueRender();
    const onRemoved = (tabId) => this.chips.delete(tabId);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    this.cleanups.push(() => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    });

    this.updateMotion();
    this.loadVivaldiState();
    this.loader.start();
  }

  listen(target, type, fn, capture) {
    target.addEventListener(type, fn, capture);
    this.cleanups.push(() => target.removeEventListener(type, fn, capture));
  }

  async loadVivaldiState() {
    try {
      this.incognito = (await chrome.windows.getCurrent()).incognito;
    } catch {}
    try {
      const prefValue = (p) => (p && typeof p === 'object' && 'value' in p ? p.value : p);
      this.openShortcut = prefValue(await vivaldi.prefs.get('vivaldi.address_bar.url_open_shortcut')) ?? 'alt';
      this.useAnimation = prefValue(await vivaldi.prefs.get('vivaldi.theme.use_animation')) !== false;
      this.updateMotion();
      const onPref = (change) => {
        if (change?.path === 'vivaldi.address_bar.url_open_shortcut') this.openShortcut = change.value;
        if (change?.path === 'vivaldi.theme.use_animation') {
          this.useAnimation = change.value !== false;
          this.updateMotion();
        }
      };
      vivaldi.prefs.onChanged.addListener(onPref);
      this.cleanups.push(() => vivaldi.prefs.onChanged.removeListener(onPref));
    } catch {}
    try {
      const refresh = () => vivaldi.searchEngines.getTemplateUrls((data) => {
        const all = [...(data?.templateUrls ?? []), ...(data?.starterPackEngines ?? [])];
        this.reserved = new Set(all.map((t) => (t.keyword || '').toLowerCase()).filter(Boolean));
        this.rebuild();
      });
      refresh();
      vivaldi.searchEngines.onTemplateUrlsChanged.addListener(refresh);
      this.cleanups.push(() => vivaldi.searchEngines.onTemplateUrlsChanged.removeListener(refresh));
    } catch {}
  }

  rebuild() {
    if (!this.rawBangs) return;
    this.catalogue = new Catalogue(this.rawBangs, this.reserved);
    this.queueRender();
  }

  // --- motion --------------------------------------------------------------

  updateMotion() {
    this.motion = this.useAnimation && !this.reducedMotion.matches;
    document.documentElement.classList.toggle('hb-motion', this.motion);
    if (!this.motion) this.finishAnimations();
  }

  // Runs a Web Animation unless motion is off. Every animation is tracked so
  // the next keystroke can complete it instantly; nothing ever waits on one.
  animate(target, keyframes, options = {}) {
    if (!this.motion || !target?.animate) return null;
    const anim = target.animate(keyframes, { duration: MOTION.normal, easing: MOTION.ease, ...options });
    this.anims.add(anim);
    anim.finished.catch(() => {}).finally(() => this.anims.delete(anim));
    return anim;
  }

  finishAnimations() {
    for (const anim of [...this.anims]) {
      try { anim.finish(); } catch { anim.cancel(); }
    }
  }

  // A detached copy of `node` at the same place on screen, for exit effects.
  ghost(node) {
    const rect = node.getBoundingClientRect();
    const copy = node.cloneNode(true);
    copy.classList.add('hb-ghost');
    Object.assign(copy.style, {
      left: rect.left + 'px', top: rect.top + 'px',
      width: rect.width + 'px', height: rect.height + 'px',
    });
    (document.getElementById('browser') ?? document.body).appendChild(copy);
    // Correct for any containing block that isn't the viewport.
    const placed = copy.getBoundingClientRect();
    copy.style.left = (2 * rect.left - placed.left) + 'px';
    copy.style.top = (2 * rect.top - placed.top) + 'px';
    return { node: copy, rect };
  }

  dropGhost(ghost, anim) {
    if (anim) anim.finished.catch(() => {}).finally(() => ghost.node.remove());
    else ghost.node.remove();
  }

  announce(text) {
    if (this.live) this.live.textContent = text;
  }

  // --- text geometry -------------------------------------------------------

  // Where the input's text starts on screen, with the canvas set to its font.
  textOrigin(input) {
    const cs = getComputedStyle(input);
    this.measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const rect = input.getBoundingClientRect();
    return {
      left: rect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - input.scrollLeft,
      font: this.measure.font,
      color: cs.color,
    };
  }

  textWidth(text) {
    return this.measure.measureText(text).width;
  }

  // Screen position of `token` within `text` as drawn in the input, plus the
  // position of the remaining query text.
  measureToken(input, text, token) {
    const idx = tokenIndex(text, token);
    if (idx < 0) return null;
    const origin = this.textOrigin(input);
    const end = idx + token.length;
    const firstChar = text.search(/\S/);
    let queryIdx = firstChar;
    if (idx === firstChar) {
      const after = text.slice(end).search(/\S/);
      queryIdx = after < 0 ? text.length : end + after;
    }
    return {
      token: text.slice(idx, end),
      left: origin.left + this.textWidth(text.slice(0, idx)),
      width: this.textWidth(text.slice(idx, end)),
      queryLeft: origin.left + this.textWidth(text.slice(0, queryIdx)),
      font: origin.font,
    };
  }

  // --- brand tint ----------------------------------------------------------

  tint(bang) {
    const origin = bangOrigin(bang);
    if (this.tints.has(origin)) return this.tints.get(origin);
    this.tints.set(origin, undefined);
    const img = new Image();
    img.onload = () => {
      let color = null;
      try { color = dominantColor(img); } catch {}
      this.tints.set(origin, color);
      this.queueRender();
    };
    img.onerror = () => this.tints.set(origin, null);
    img.src = faviconUrl(bang, 32);
    return undefined;
  }

  applyTint(node, bang) {
    const color = this.tint(bang);
    if (color) node.style.setProperty('--hb-tint', color);
    else node.style.removeProperty('--hb-tint');
  }

  // --- state helpers -------------------------------------------------------

  context(input) {
    const ctrl = findController(input);
    const pageId = ctrl?.props?.pageId ?? 'default';
    let chip = this.chips.get(pageId) ?? null;
    // Vivaldi dropped the typed text (navigation, Escape, revert): the
    // keyword mode goes with it.
    if (chip && ctrl && ctrl.props.typedUrl === undefined) {
      this.chips.delete(pageId);
      chip = null;
    }
    const results = ctrl?.state?.omniboxResults ?? [];
    return {
      ctrl, pageId, chip, results,
      selection: ctrl?.state?.dropdownSelectionIndex ?? 0,
      // Only take over when Vivaldi's default row is a search for the typed
      // text, like Helium's IsSearchType(current_match_) check.
      defaultIsSearch: !results.length || results[0]?.category === 'search',
    };
  }

  // The text the user typed, without Vivaldi's selected inline completion.
  typedText(input, cx) {
    const typed = cx.ctrl?.props?.typedUrl;
    const value = input.value;
    if (typeof typed === 'string' && typed.length < value.length && value.startsWith(typed) &&
        input.selectionStart === typed.length && input.selectionEnd === value.length) {
      return typed;
    }
    return value;
  }

  // What the user currently has: a chip, or a bang found in the text.
  target(input, cx) {
    const text = this.typedText(input, cx);
    if (cx.chip) return { bang: cx.chip.bang, query: text, viaChip: true, keyword: null };
    if (!this.catalogue) return null;
    const found = findBang(text, this.catalogue);
    return found ? { bang: found.bang, query: found.query, viaChip: false, keyword: found.keyword } : null;
  }

  // The `!word` in the text that a row was derived from, for the morph.
  sourceToken(input, cx, row) {
    if (row.primary) return this.target(input, cx)?.keyword ?? null;
    const token = this.typedText(input, cx).trim();
    return token.startsWith('!') ? token : null;
  }

  // Replaces the text the way typing would. Vivaldi inline-autocompletes text
  // that grows unless it ends in a space or gets shorter, so restored text is
  // first set with a trailing space, which is trimmed once Vivaldi has seen it.
  setText(input, text, { autocomplete = true } = {}) {
    const write = (value) => {
      setInputValue.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.setSelectionRange(value.length, value.length);
    };
    if (autocomplete || /\s$/.test(text)) {
      write(text);
      return;
    }
    const padded = text + ' ';
    write(padded);
    requestAnimationFrame(() => {
      if (input.value === padded) write(text);
    });
  }

  chipElement(input) {
    return input.parentElement?.querySelector(':scope > .hb-chip') ?? null;
  }

  enterKeywordMode(input, cx, bang, query, original, token) {
    this.finishAnimations();
    const from = this.motion && token ? this.measureToken(input, input.value, token) : null;
    this.chips.set(cx.pageId, { bang, query: query.trim(), original });
    this.setText(input, query.trim() ? query.trim() + ' ' : '');
    this.render();
    this.announce(actionLabel(bang));
    if (from) this.morphIn(input, from);
  }

  exitKeywordMode(input, cx, restore) {
    const chip = cx.chip;
    this.chips.delete(cx.pageId);
    if (restore && chip) {
      const current = input.value.trim();
      const text = current === chip.query && chip.original != null
        ? chip.original
        : ('!' + chip.bang.trigger + (current ? ' ' + current : ''));
      this.setText(input, text, { autocomplete: false });
    }
    this.render();
    this.announce('');
  }

  // Backspace or the chip's close button: the chip folds back into `!gh`.
  leaveKeywordMode(input, cx) {
    this.finishAnimations();
    const chipNode = this.chipElement(input);
    const ghost = this.motion && chipNode ? this.ghost(chipNode) : null;
    const textColor = getComputedStyle(input).color;
    this.exitKeywordMode(input, cx, true);
    if (ghost) this.morphOut(input, ghost, '!' + cx.chip.bang.trigger, textColor);
  }

  // Escape: the chip just fades away; Vivaldi restores the address.
  cancelKeywordMode(input, cx) {
    this.finishAnimations();
    const chipNode = this.chipElement(input);
    const ghost = this.motion && chipNode ? this.ghost(chipNode) : null;
    this.exitKeywordMode(input, cx, false);
    if (ghost) {
      this.dropGhost(ghost, this.animate(ghost.node, [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateX(-8px)' },
      ], { duration: MOTION.fast, easing: MOTION.exit }));
    }
  }

  navigate(input, cx, bang, query, modifiers) {
    this.finishAnimations();
    this.launchFeedback(input);
    const url = buildUrl(bang, query);
    this.chips.delete(cx.pageId);
    const opts = openOptions(modifiers, this.openShortcut, this.incognito);
    opts.transition = vivaldi.historyPrivate?.TransitionType?.TYPED ?? 'typed';
    if (cx.ctrl) {
      cx.ctrl.hideDropdown();
      cx.ctrl._urlFieldGo(url, opts);
    } else {
      this.fallbackNavigate(url, opts);
    }
    this.announce('');
    this.queueRender();
  }

  // Used only if Vivaldi's internals change and the controller can't be found.
  async fallbackNavigate(url, opts) {
    const win = await chrome.windows.getCurrent();
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (opts.inNewWindow) chrome.windows.create({ url, incognito: opts.incognito });
    else if (!opts.inCurrent || !tab) chrome.tabs.create({ url, windowId: win.id, active: !opts.inBackground, index: tab ? tab.index + 1 : undefined });
    else chrome.tabs.update(tab.id, { url });
  }

  // --- animations ----------------------------------------------------------

  // The typed `!gh` slides into the chip's place and becomes the chip, while
  // the query text slides to its new position after it.
  morphIn(input, from) {
    const chip = this.chipElement(input);
    if (!chip) return;
    const rect = chip.getBoundingClientRect();
    const radius = getComputedStyle(chip).borderRadius;
    const startWidth = Math.min(rect.width, from.width + CHIP_TOKEN_INSET * 2);
    const dx = from.left - CHIP_TOKEN_INSET - rect.left;

    const token = chip.querySelector('.hb-chip-token');
    token.textContent = from.token;
    token.style.font = from.font;

    this.animate(chip, [
      { transform: `translateX(${dx}px)`, clipPath: `inset(0 ${rect.width - startWidth}px 0 0 round ${radius})` },
      { transform: 'none', clipPath: `inset(0 0 0 0 round ${radius})` },
    ]);
    this.animate(token, [{ opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }]);
    this.animate(chip.querySelector('.hb-chip-body'), [
      { opacity: 0, transform: 'translateX(-6px)' },
      { opacity: 0, transform: 'translateX(-6px)', offset: 0.3 },
      { opacity: 1, transform: 'none' },
    ]);
    this.animate(chip.querySelector('.hb-chip-icon'), [{ transform: 'scale(0.6)' }, { transform: 'none' }]);

    if (input.value.trim()) {
      const now = this.textOrigin(input).left;
      // A trailing or middle bang travels left across the query text, so the
      // text dips while they pass each other.
      const crossing = from.left > from.queryLeft;
      this.animate(input, [
        { transform: `translateX(${from.queryLeft - now}px)`, opacity: 1 },
        ...(crossing ? [{ opacity: 0.3, offset: 0.4 }] : []),
        { transform: 'none', opacity: 1 },
      ]);
    }

    if (chip.classList.contains('hb-ai')) {
      this.animate(chip.querySelector('.hb-chip-label'), [
        { backgroundPosition: '0% 0' }, { backgroundPosition: '100% 0' },
      ], { duration: 900, delay: MOTION.normal * 0.6, easing: 'ease-in-out', fill: 'backwards' });
    }
  }

  // Reverse of morphIn, played on a ghost of the removed chip: it narrows
  // back into the `!gh` text while the restored text fades in under it.
  morphOut(input, ghost, keyword, textColor) {
    const to = this.measureToken(input, input.value, keyword);
    if (!to) {
      this.dropGhost(ghost, this.animate(ghost.node, [{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.fast }));
      return;
    }
    const width = ghost.rect.width;
    const endWidth = Math.min(width, to.width + CHIP_TOKEN_INSET * 2);
    const dx = to.left - CHIP_TOKEN_INSET - ghost.rect.left;
    const radius = getComputedStyle(ghost.node).borderRadius;

    const token = ghost.node.querySelector('.hb-chip-token');
    token.textContent = to.token;
    token.style.font = to.font;

    this.dropGhost(ghost, this.animate(ghost.node, [
      { transform: 'none', clipPath: `inset(0 0 0 0 round ${radius})`, opacity: 1 },
      { transform: `translateX(${dx}px)`, clipPath: `inset(0 ${width - endWidth}px 0 0 round ${radius})`, opacity: 1, offset: 0.8 },
      { transform: `translateX(${dx}px)`, clipPath: `inset(0 ${width - endWidth}px 0 0 round ${radius})`, opacity: 0 },
    ]));
    this.animate(ghost.node.querySelector('.hb-chip-body'), [
      { opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 },
    ]);
    this.animate(token, [{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }]);
    this.animate(input, [{ color: 'transparent' }, { color: 'transparent', offset: 0.55 }, { color: textColor }]);
  }

  // A short "sent" nudge on the chip (or the highlighted bang in the text).
  launchFeedback(input) {
    if (!this.motion) return;
    const source = this.chipElement(input) ?? input.parentElement?.querySelector(':scope > .hb-token');
    if (!source) return;
    const ghost = this.ghost(source);
    this.dropGhost(ghost, this.animate(ghost.node, [
      { transform: 'none', opacity: 1, filter: 'brightness(1)' },
      { transform: 'translateX(3px)', opacity: 1, filter: 'brightness(1.4)', offset: 0.35 },
      { transform: 'translateX(12px)', opacity: 0, filter: 'brightness(1)' },
    ], { duration: MOTION.normal, easing: MOTION.exit }));
  }

  // --- keyboard ------------------------------------------------------------

  onKeyDown(e) {
    const input = e.target;
    if (input?.id !== INPUT_ID || e.isComposing || !this.catalogue) return;
    // Typing never waits for an animation.
    if (this.anims.size) this.finishAnimations();
    const cx = this.context(input);

    switch (e.key) {
      case 'Enter': {
        if (cx.selection !== 0) return;  // The user picked another suggestion.
        const t = this.target(input, cx);
        if (!t || (!t.viaChip && !cx.defaultIsSearch)) return;
        this.swallow(e);
        this.navigate(input, cx, t.bang, t.query, e);
        return;
      }
      case ' ': {
        // Typing a space after a bang enters keyword mode, wherever the bang is.
        if (cx.chip || e.ctrlKey || e.altKey || e.metaKey) return;
        if (input.selectionEnd !== input.value.length) return;
        const before = input.value.slice(0, input.selectionStart);
        const found = findBang(before + ' ', this.catalogue);
        if (!found) return;
        this.swallow(e);
        this.enterKeywordMode(input, cx, found.bang, found.query, before, found.keyword);
        return;
      }
      case 'Tab': {
        // Tab accepts the bang hint, as in Chromium's "Press Tab to search".
        if (cx.chip || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        const rows = this.rows(input, cx);
        if (!rows.length) return;
        this.swallow(e);
        const row = rows[0];
        this.enterKeywordMode(input, cx, row.bang, row.query, input.value, this.sourceToken(input, cx, row));
        return;
      }
      case 'Backspace': {
        // Backspace at the start of the text leaves keyword mode.
        if (!cx.chip || input.selectionStart !== 0 || input.selectionEnd !== 0) return;
        this.swallow(e);
        this.leaveKeywordMode(input, cx);
        return;
      }
      case 'Escape':
        if (cx.chip) this.cancelKeywordMode(input, cx);
        return;
    }
  }

  swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  onBlur(input) {
    // An empty keyword mode would otherwise sit next to the page URL.
    setTimeout(() => {
      const cx = this.context(input);
      if (cx.chip && !input.value.trim() && document.activeElement !== input) {
        this.chips.delete(cx.pageId);
      }
      this.queueRender();
    }, 0);
  }

  // --- rendering -----------------------------------------------------------

  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  // Suggestion rows: the bang that Enter would use, then `!prefix` matches.
  rows(input, cx) {
    const t = this.target(input, cx);
    const rows = [];
    if (t && (t.viaChip || cx.defaultIsSearch)) {
      rows.push({ bang: t.bang, query: t.query, primary: true });
    }
    if (!cx.chip && this.catalogue) {
      const token = this.typedText(input, cx).trim();
      if (/^![^\s]*$/.test(token)) {
        for (const bang of this.catalogue.suggest(token.slice(1), CONFIG.maxSuggestions + 1)) {
          if (rows.length >= CONFIG.maxSuggestions) break;
          if (rows.some((r) => r.bang === bang)) continue;
          rows.push({ bang, query: '', primary: false });
        }
      }
    }
    return rows;
  }

  render() {
    const input = document.getElementById(INPUT_ID);
    if (!input) return;
    const field = input.closest('.UrlBar-AddressField') ?? input.parentElement;
    if (field !== this.observed) {
      this.observer.disconnect();
      this.observer.observe(field, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['aria-activedescendant', 'class'],
      });
      this.observed = field;
    }

    const cx = this.context(input);
    // In keyword mode the text is a search query, so Vivaldi's address
    // completion (`x` -> `x.com`) doesn't apply, as in Chromium.
    if (cx.chip && document.activeElement === input) {
      const typed = this.typedText(input, cx);
      if (typed !== input.value) this.setText(input, typed);
    }
    this.renderChip(input, cx.chip);
    this.renderToken(input, cx);
    this.renderRows(input, cx);
  }

  renderChip(input, chip) {
    const wrap = input.parentElement;
    let node = wrap.querySelector(':scope > .hb-chip');
    if (!chip) {
      if (node) {
        node.remove();
        if (input.dataset.hbPlaceholder != null) {
          input.placeholder = input.dataset.hbPlaceholder;
          delete input.dataset.hbPlaceholder;
        }
      }
      return;
    }
    const { bang } = chip;
    if (!node || node.dataset.trigger !== bang.trigger) {
      node?.remove();
      node = el('div', 'hb-chip' + (bang.category === CATEGORY_AI ? ' hb-ai' : ''));
      node.dataset.trigger = bang.trigger;
      node.title = `!${bang.trigger} · ${bangDomain(bang)}`;

      const close = el('button', 'hb-chip-close');
      close.type = 'button';
      close.tabIndex = -1;
      close.setAttribute('aria-label', 'Exit ' + actionLabel(bang));
      close.innerHTML = CLOSE_ICON;
      close.addEventListener('mousedown', (e) => e.preventDefault());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        const cx = this.context(input);
        if (cx.chip) this.leaveKeywordMode(input, cx);
        input.focus();
      });

      const icon = el('span', 'hb-chip-icon');
      icon.append(bangIcon(bang), close);
      const body = el('span', 'hb-chip-body');
      body.append(icon, el('span', 'hb-chip-label', actionLabel(bang)));
      node.append(body, el('span', 'hb-chip-token'));
      node.addEventListener('mousedown', (e) => {
        if (e.target.closest('.hb-chip-close')) return;
        e.preventDefault();
        input.focus();
      });
      wrap.insertBefore(node, input);
    }
    this.applyTint(node, bang);
    if (input.dataset.hbPlaceholder == null) input.dataset.hbPlaceholder = input.placeholder;
    const placeholder = emptyLabel(bang);
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
  }

  // A soft pill behind a recognised bang in the text, so it's clear which
  // word Enter will use.
  renderToken(input, cx) {
    const wrap = input.parentElement;
    let pill = wrap.querySelector(':scope > .hb-token');
    let found = null;
    if (!cx.chip && this.catalogue && cx.defaultIsSearch && cx.selection === 0 &&
        document.activeElement === input) {
      found = findBang(this.typedText(input, cx), this.catalogue);
    }
    const at = found && this.measureToken(input, input.value, found.keyword);
    const wrapRect = wrap.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    if (!at || at.left < inputRect.left || at.left + at.width > inputRect.right) {
      pill?.remove();
      return;
    }

    const isNew = !pill || pill.dataset.keyword !== found.keyword.toLowerCase();
    if (!pill) {
      pill = el('div', 'hb-token');
      wrap.insertBefore(pill, input);
    }
    pill.dataset.keyword = found.keyword.toLowerCase();
    this.applyTint(pill, found.bang);
    Object.assign(pill.style, {
      left: (at.left - wrapRect.left - wrap.clientLeft - 3) + 'px',
      width: (at.width + 6) + 'px',
      top: (inputRect.top - wrapRect.top - wrap.clientTop + (inputRect.height - 20) / 2) + 'px',
    });
    if (isNew) {
      this.animate(pill, [{ opacity: 0, transform: 'scale(0.85)' }, { opacity: 1, transform: 'none' }],
                   { duration: MOTION.fast });
    }
  }

  renderRows(input, cx) {
    const dropdown = input.closest('.UrlBar-AddressField')?.querySelector('.OmniDropdown') ??
                     document.querySelector('.OmniDropdown');
    const existing = document.querySelectorAll('.hb-rows');

    // While the user arrows through Vivaldi's suggestions, the field shows
    // the selected suggestion; keep the bang rows as they were, unhighlighted.
    const current = dropdown?.querySelector(':scope > .hb-rows');
    if (current && cx.selection !== 0 && document.activeElement === input) {
      current.querySelectorAll('.OmniLinkItem--Highlighted').forEach((li) => {
        li.classList.remove('OmniLinkItem--Highlighted');
        li.setAttribute('aria-selected', 'false');
        current.dataset.signature = '';
      });
      return;
    }

    const rows = dropdown && document.activeElement === input ? this.rows(input, cx) : [];

    if (!rows.length) {
      existing.forEach((node) => node.remove());
      document.querySelectorAll('.hb-footer').forEach((node) => node.remove());
      document.querySelectorAll('.OmniDropdown[data-hb-hide-first]')
          .forEach((node) => node.removeAttribute('data-hb-hide-first'));
      return;
    }

    const primary = rows[0].primary;
    const highlight = primary && cx.selection === 0;
    // Bold the part of each trigger the user has typed (`!g` in `!gh`).
    const token = this.typedText(input, cx).trim();
    const typedPrefix = !cx.chip && /^![^\s]*$/.test(token) ? token.slice(1).toLowerCase() : null;
    const signature = JSON.stringify([rows.map((r) => [r.bang.trigger, r.query, r.primary]), highlight, typedPrefix]);
    let list = dropdown.querySelector(':scope > .hb-rows');
    existing.forEach((node) => node !== list && node.remove());

    // The primary row stands in for Vivaldi's "search for what you typed" row.
    const hideFirst = primary && !!cx.results.length && cx.defaultIsSearch;
    if (hideFirst !== dropdown.hasAttribute('data-hb-hide-first')) {
      dropdown.toggleAttribute('data-hb-hide-first', hideFirst);
    }

    this.renderFooter(dropdown, cx, primary);

    if (list && list.dataset.signature === signature && list === dropdown.firstElementChild) return;
    if (!list) {
      list = el('ul', 'OmniDropdown-Collection hb-rows');
      list.setAttribute('role', 'listbox');
    }
    const set = rows.map((r) => r.bang.trigger).join(' ');
    const entering = list.dataset.set !== set;
    list.dataset.signature = signature;
    list.dataset.set = set;
    const items = rows.map((row, i) => this.rowElement(input, row, i === 0 && highlight, typedPrefix));
    list.replaceChildren(...items);
    if (dropdown.firstElementChild !== list) dropdown.insertBefore(list, dropdown.firstElementChild);

    // Rows ease in only when the set of bangs changes, not on every keystroke.
    if (entering) {
      items.forEach((li, i) => this.animate(li, [
        { opacity: 0, transform: 'translateY(-4px)' },
        { opacity: 1, transform: 'none' },
      ], { duration: MOTION.normal, delay: i * MOTION.stagger, fill: 'backwards' }));
    }
  }

  // Keyboard hints for what the bang rows respond to right now.
  renderFooter(dropdown, cx, primary) {
    const hints = cx.chip ? [['⏎', 'search'], ['⌫', 'exit'], ['Esc', 'cancel']]
                : primary ? [['Tab', 'select'], ['Space', 'search'], ['⏎', 'go']]
                : [['Tab', 'select']];
    const key = hints.map((h) => h.join(':')).join('|');
    let footer = dropdown.querySelector(':scope > .hb-footer');
    if (!footer) {
      footer = el('div', 'hb-footer');
      footer.setAttribute('aria-hidden', 'true');
      footer.addEventListener('mousedown', (e) => e.preventDefault());
    }
    if (footer.dataset.key !== key) {
      footer.dataset.key = key;
      footer.replaceChildren(...hints.map(([k, label]) => {
        const span = el('span');
        span.append(el('kbd', null, k), label);
        return span;
      }));
    }
    if (dropdown.lastElementChild !== footer) dropdown.appendChild(footer);
  }

  rowElement(input, row, highlighted, typedPrefix) {
    const { bang } = row;
    const li = el('li', 'omni-clickable OmniLinkItem' + (highlighted ? ' OmniLinkItem--Highlighted' : ''));
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(highlighted));

    const icon = el('div', 'OmniLinkItem-Favicon');
    icon.append(bangIcon(bang));

    const text = el('div', 'OmniLinkItem-DisplayText');
    const title = el('span', 'displayTitle');
    const query = row.query.trim();
    title.append(query ? el('b', null, query) : el('span', 'hb-dim', emptyLabel(bang)));
    const desc = el('span', 'displayUrl', actionLabel(bang));
    desc.append(el('span', 'hb-domain', ' · ' + bangDomain(bang)));
    text.append(title, el('span', null, '–'), desc);

    const badge = el('span', 'OmniLinkItem-Badge hb-key', '!');
    const matched = row.primary ? bang.trigger.length
                  : typedPrefix && bang.trigger.startsWith(typedPrefix) ? typedPrefix.length : 0;
    badge.append(el('b', null, bang.trigger.slice(0, matched)),
                 el('span', 'hb-rest', bang.trigger.slice(matched)));

    li.append(icon, text, badge);
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', (e) => {
      const cx = this.context(input);
      if (row.primary && query) this.navigate(input, cx, bang, query, e);
      else if (!cx.chip) this.enterKeywordMode(input, cx, bang, query, input.value, this.sourceToken(input, cx, row));
      input.focus();
    });
    return li;
  }

  dispose() {
    this.loader.dispose();
    this.observer.disconnect();
    this.finishAnimations();
    this.cleanups.forEach((fn) => fn());
    document.documentElement.classList.remove('hb-motion');
    document.querySelectorAll('.hb-chip, .hb-rows, .hb-token, .hb-footer, .hb-ghost')
        .forEach((node) => node.remove());
  }
}

// Re-injection (development) replaces the previous instance cleanly.
window.__heliumBangs?.dispose();
const instance = new AddressBarBangs();
window.__heliumBangs = Object.assign(instance, { core });
instance.start();
})();
