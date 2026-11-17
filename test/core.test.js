// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../helium-bangs.js');

const SAMPLE = `// header comment, with a // URL-looking thing
[
 {
  "s": "GitHub",
  "ts": [
   "gh",
   "github",
  ],
  "u": "https://github.com/search?q={searchTerms}",
 },
 { "s": "Wikipedia", "ts": [ "w" ], "u": "https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}" },
 { "s": "cobalt", "ts": [ "co" ], "u": "https://cobalt.tools/#{searchTerms}" },
 { "s": "Reddit sub", "ts": [ "sub" ], "u": "https://www.reddit.com/r/{searchTerms}", "f": 1 },
 { "s": "ChatGPT", "ts": [ "gpt" ], "u": "https://chatgpt.com/?q={searchTerms}", "sc": "ai" },
 { "s": "Bad scheme", "ts": [ "bad" ], "u": "javascript:alert({searchTerms})" },
 { "s": "", "ts": [ "noname" ], "u": "https://example.com/?q={searchTerms}" },
 { "s": "Dup", "ts": [ "GH" ], "u": "https://dup.example/?q={searchTerms}" },
]`;

const bangs = core.parseManifest(SAMPLE);
const cat = new core.Catalogue(bangs);

test('parses comments and trailing commas, skips malformed entries', () => {
  assert.deepEqual(bangs.map((b) => b.trigger), ['gh', 'github', 'w', 'co', 'sub', 'gpt', 'gh']);
  assert.equal(bangs.find((b) => b.trigger === 'gpt').category, core.CATEGORY_AI);
});

test('first definition of a trigger wins; lookup is case-insensitive', () => {
  assert.equal(cat.lookup('!GH').name, 'GitHub');
  assert.equal(cat.lookup('!nope'), null);
  assert.equal(cat.lookup('!'), null);
});

test('user search engine keywords take precedence over bangs', () => {
  const c = new core.Catalogue(bangs, new Set(['!w']));
  assert.equal(c.lookup('!w'), null);
  assert.equal(c.lookup('!gh').name, 'GitHub');
});

test('splitBang: leading, trailing and middle bangs', () => {
  assert.deepEqual(core.splitBang('!gh react hooks'), { keyword: '!gh', query: 'react hooks' });
  assert.deepEqual(core.splitBang('  !gh'), { keyword: '!gh', query: '' });
  assert.deepEqual(core.splitBang('react hooks !gh'), { keyword: '!gh', query: 'react hooks' });
  assert.deepEqual(core.splitBang('react !gh hooks'), { keyword: '!gh', query: 'react hooks' });
  assert.equal(core.splitBang('hello! world'), null);
  assert.equal(core.splitBang('https://x.com/!gh'), null);
  assert.equal(core.splitBang('a ! b'), null);
});

test('findBang ignores unknown bangs and finds a later known one', () => {
  assert.equal(core.findBang('foo !zzz', cat), null);
  assert.equal(core.findBang('!zzz foo !w', cat).bang.name, 'Wikipedia');
  assert.equal(core.findBang('foo !zzz', cat), null);
  assert.equal(core.findBang('rust !GH', cat).query, 'rust');
});

test('buildUrl escapes like Chromium template URLs', () => {
  const gh = cat.lookup('!gh');
  assert.equal(core.buildUrl(gh, 'a b&c/d'), 'https://github.com/search?q=a+b%26c%2Fd');
  assert.equal(core.buildUrl(cat.lookup('!co'), 'a b/c'), 'https://cobalt.tools/#a%20b/c');
  assert.equal(core.buildUrl(cat.lookup('!sub'), 'rust lang'), 'https://www.reddit.com/r/rust%20lang');
  assert.equal(core.buildUrl(gh, 'ünï'), 'https://github.com/search?q=%C3%BCn%C3%AF');
});

test('a bare bang opens the site (or its base path when flagged)', () => {
  assert.equal(core.buildUrl(cat.lookup('!gh'), '  '), 'https://github.com/');
  assert.equal(core.buildUrl(cat.lookup('!sub'), ''), 'https://www.reddit.com/r/');
});

test('suggest: shortest first, then alphabetical', () => {
  assert.deepEqual(cat.suggest('g', 5).map((b) => b.trigger), ['gh', 'gpt', 'github']);
  assert.deepEqual(cat.suggest('', 2).map((b) => b.trigger), ['w', 'co']);
});

test('openOptions mirrors Vivaldi modifiers', () => {
  const k = (s) => ({ ctrlKey: s.includes('c'), altKey: s.includes('a'), shiftKey: s.includes('s') });
  const pick = ({ inCurrent, inBackground, inNewWindow, incognito }) => ({ inCurrent, inBackground, inNewWindow, incognito });
  assert.deepEqual(pick(core.openOptions(k(''), 'alt', false)), { inCurrent: true, inBackground: false, inNewWindow: false, incognito: false });
  assert.deepEqual(pick(core.openOptions(k('a'), 'alt', false)), { inCurrent: false, inBackground: false, inNewWindow: false, incognito: false });
  assert.deepEqual(pick(core.openOptions(k('s'), 'alt', false)), { inCurrent: false, inBackground: false, inNewWindow: false, incognito: false });
  assert.deepEqual(pick(core.openOptions(k('c'), 'alt', false)), { inCurrent: false, inBackground: true, inNewWindow: false, incognito: false });
  assert.deepEqual(pick(core.openOptions(k('ca'), 'alt', false)), { inCurrent: false, inBackground: true, inNewWindow: false, incognito: false });
  assert.equal(core.openOptions(k('cs'), 'alt', false).inNewWindow, true);
  assert.equal(core.openOptions(k('', ), 'alt', true).incognito, true);
});

// Full list from imputnet/helium-services, if a copy is available.
const REAL = process.env.HELIUM_BANGS_JSON;
test('parses the real Helium bangs.json', { skip: !REAL || !fs.existsSync(REAL) }, () => {
  const all = core.parseManifest(fs.readFileSync(REAL, 'utf8'));
  const real = new core.Catalogue(all);
  assert.ok(real.size > 10000, `only ${real.size} bangs`);
  assert.equal(real.lookup('!gh').name, 'GitHub');
  assert.equal(real.lookup('!w').name, 'Wikipedia');
  assert.equal(real.lookup('!yt').name, 'YouTube');
  assert.equal(real.lookup('!kai').category, core.CATEGORY_AI);
  for (const b of all) core.buildUrl(b, 'test query');  // every template must build
});
