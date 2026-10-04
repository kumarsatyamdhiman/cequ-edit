import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDirect, setAttrs, getAttr, mergeStyle, hexToOklch, formatColor } from '../direct.mjs';
import { isDirect } from '../overlay/kinds.js';
import { position, elementSource } from '../stamp.mjs';

const PAGE = `<!doctype html>
<html><head><link rel="stylesheet" href="css/site.css"></head><body>
<h1 class="title">Old title</h1>
<p class="lede">Hello <b>world</b></p>
<figure class="pic"><img src="img/a.jpg" width="10" height="10" alt="Old alt" style="filter:none"><figcaption>Old alt</figcaption></figure>
<div class="card">Card</div>
<img src="img/a.jpg" alt="second">
</body></html>
`;
const ABOUT = '<!doctype html>\n<html><body>\n<img src="../img/a.jpg" alt="x">\n</body></html>\n';
const CSS = ':root {\n  --accent: oklch(0.62 0.19 45);\n  --ink: oklch(0.27 0.045 35);\n}\n.title { color: var(--accent); }\n.card {\n  padding: 4px;\n}\n';
const BP = { phone: '(max-width: 900px)', desktop: '(min-width: 901px)' };
let dir;
const read = f => readFileSync(join(dir, f), 'utf8');

// target for the first element whose start tag begins with `needle`
function target(needle, file = 'index.html', extra = {}) {
  const html = read(file);
  const at = html.indexOf(needle);
  const { line, col } = position(html, at);
  const el = elementSource(html, line, col);
  return { src: `${file}:${line}:${col}`, snippet: el.text, tag: /^<(\w+)/.exec(el.text)[1],
    cssRules: [{ at: 'css/site.css:5', selector: '.title', media: null, decls: {} }], ...extra };
}
const run = (items, d = dir) => applyDirect({ dir: d, items: items.map((it, i) => ({ id: i + 1, screens: 'all', instruction: '', ...it })), breakpoints: BP });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cequ-direct-'));
  mkdirSync(join(dir, 'css')); mkdirSync(join(dir, 'about')); mkdirSync(join(dir, 'img', 'uploads'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), PAGE);
  writeFileSync(join(dir, 'about', 'index.html'), ABOUT);
  writeFileSync(join(dir, 'css', 'site.css'), CSS);
});

test('only control-only items on source elements are instant', () => {
  assert.equal(isDirect({ instruction: '', target: {}, payload: { text: {} } }), true);
  assert.equal(isDirect({ instruction: 'make it pop', target: {}, payload: { text: {} } }), false);
  assert.equal(isDirect({ instruction: '', target: { generatedBy: 'script' }, payload: { text: {} } }), false);
  assert.equal(isDirect({ instruction: '', target: {}, payload: {} }), false);
});

test('tag helpers keep everything else exactly as written', () => {
  assert.equal(setAttrs('<img src="a.jpg"  alt=x loading=lazy>', { src: 'b.jpg', alt: 'y "q"', width: 5 }), '<img src="b.jpg"  alt="y &quot;q&quot;" loading=lazy width="5">');
  assert.equal(setAttrs('<use href="#p"/>', { class: 'c' }), '<use href="#p" class="c"/>');
  assert.equal(setAttrs('<p class="a" style="x:1">', { style: null }), '<p class="a">');
  assert.equal(getAttr('<p data-class="no" class="yes">', 'class'), 'yes');
  assert.equal(mergeStyle('object-position:72% 40%; filter: none', { 'object-position': '10% 20%', width: '50%' }), 'object-position: 10% 20%; filter: none; width: 50%');
  assert.equal(hexToOklch('#ffffff'), 'oklch(1.000 0.000 0)');
  assert.equal(hexToOklch('#ff0000'), 'oklch(0.628 0.258 29)');
  assert.equal(formatColor('#FF0000', 'a{color:oklch(1 0 0)}'), 'oklch(0.628 0.258 29)');
  assert.equal(formatColor('#FF0000', 'a{color:#333}'), '#ff0000');
  assert.equal(formatColor('var(--ink)', ''), 'var(--ink)');
});

test('text: exact inner HTML swap, markup kept', async () => {
  const r = await run([
    { kind: 'text', target: target('<h1'), payload: { text: { from: 'Old title', to: 'New title', plain: 'New title' } } },
    { kind: 'text', target: target('<p'), payload: { text: { from: 'Hello <b>world</b>', to: 'Hi <b>there</b>', plain: 'Hi there' } } },
  ]);
  assert.deepEqual(r.map(x => x.status), ['done', 'done']);
  assert.match(read('index.html'), /<h1 class="title">New title<\/h1>\n<p class="lede">Hi <b>there<\/b><\/p>/);
  assert.equal(r[0].summary, 'Text changed to "New title"');
});

test('image here: src/size/alt/focal set, caption follows the alt, other copies untouched', async () => {
  const img = { file: 'img/uploads/x.jpg', width: 800, height: 600, alt: 'New alt', focal: '30% 40%', scope: 'here' };
  const r = await run([{ kind: 'image', target: target('<img src="img/a.jpg" width'), payload: { image: img } }]);
  assert.equal(r[0].status, 'done');
  const html = read('index.html');
  assert.match(html, /<img src="img\/uploads\/x.jpg" width="800" height="600" alt="New alt" style="filter: none; object-position: 30% 40%"><figcaption>New alt<\/figcaption>/);
  assert.match(html, /<img src="img\/a.jpg" alt="second">/);
});

test('image everywhere: every page, relative paths per page', async () => {
  const img = { file: 'img/uploads/x.jpg', width: 800, height: 600, alt: 'All', scope: 'everywhere' };
  const r = await run([{ kind: 'image', target: target('<img src="img/a.jpg" width'), payload: { image: img } }]);
  assert.match(r[0].summary, /everywhere \(3 places\)/);
  assert.match(read('index.html'), /<img src="img\/uploads\/x.jpg" alt="All" width="800" height="600">/);
  assert.match(read('about/index.html'), /<img src="..\/img\/uploads\/x.jpg" alt="All" width="800" height="600">/);
});

test('image inside a wrapper is found through imgAt', async () => {
  const fig = target('<figure');
  const img = target('<img src="img/a.jpg" width');
  const r = await run([{ kind: 'image', target: fig, payload: { image: { file: 'img/uploads/x.jpg', width: 1, height: 1, alt: 'Old alt', scope: 'here', imgAt: img.src } } }]);
  assert.equal(r[0].status, 'done');
  assert.match(read('index.html'), /<img src="img\/uploads\/x.jpg" width="1" height="1"/);
});

test('layout: inline on all screens, class + media rule for phone only', async () => {
  await run([
    { kind: 'image', target: target('<img src="img/a.jpg" width'), payload: { layout: { align: 'center', width: '50%', fit: 'contain' } } },
    { kind: 'general', target: target('<p'), payload: { layout: { align: 'right' } } },
  ]);
  const html = read('index.html');
  assert.match(html, /style="filter: none; display: block; margin-inline: auto; width: 50%; height: auto; object-fit: contain"/);
  assert.match(html, /<p class="lede" style="text-align: right">/);
  const r = await run([{ kind: 'general', screens: 'phone', target: target('<div'), payload: { layout: { width: '100%' } } }]);
  assert.equal(r[0].status, 'done');
  const cls = /<div class="card (cq-[0-9a-f]{6})">/.exec(read('index.html'))[1];
  assert.match(read('css/site.css'), new RegExp(`@media \\(max-width: 900px\\) \\{ \\.${cls} \\{ width: 100% !important; \\} \\}`));
});

test('colour: element inline, all-like-it in the shared rule (in the sheet\'s format), site variable in :root', async () => {
  const r = await run([
    { kind: 'color', target: target('<p'), payload: { color: [{ property: 'color', to: 'var(--ink)', scope: 'element' }] } },
    { kind: 'color', target: target('<h1', 'index.html', { alike: { selector: '.title', count: 1 } }), payload: { color: [{ property: 'color', to: '#ff0000', scope: 'alike' }] } },
    { kind: 'color', target: target('<div'), payload: { color: [{ property: 'color', to: '#ffffff', scope: 'token', token: '--ink' }] } },
  ]);
  assert.deepEqual(r.map(x => x.status), ['done', 'done', 'done']);
  assert.match(read('index.html'), /<p class="lede" style="color: var\(--ink\)">/);
  const css = read('css/site.css');
  assert.match(css, /\.title \{ color: oklch\(0\.628 0\.258 29\); \}/);
  assert.match(css, /:root \{\n  --accent: oklch\(0\.62 0\.19 45\);\n  --ink: oklch\(1\.000 0\.000 0\);\n\}/);
});

test('remove deletes the whole line; hide-on-phone adds a rule', async () => {
  await run([{ kind: 'remove', target: target('<div'), payload: { remove: { mode: 'remove' } } }]);
  assert.doesNotMatch(read('index.html'), /card/);
  assert.match(read('index.html'), /<\/figure>\n<img src="img\/a.jpg" alt="second">/);
  await run([{ kind: 'remove', target: target('<p'), payload: { remove: { mode: 'hide-phone' } } }]);
  assert.match(read('css/site.css'), /@media \(max-width: 900px\) \{ \.cq-[0-9a-f]{6} \{ display: none !important; \} \}/);
});

test('when the source changed, the item falls back to Claude and nothing is written', async () => {
  const t = target('<h1');
  writeFileSync(join(dir, 'index.html'), PAGE.replace('Old title', 'Edited by hand'));
  const r = await run([{ kind: 'text', target: t, payload: { text: { from: 'Old title', to: 'X', plain: 'X' } } }]);
  assert.equal(r[0].status, 'fallback');
  assert.match(r[0].reason, /changed/);
  assert.match(read('index.html'), /Edited by hand/);
});

test('instruction items are left for Claude', async () => {
  const r = await run([{ kind: 'text', instruction: 'make it friendlier', target: target('<h1'), payload: { text: { from: 'Old title', to: 'X' } } }]);
  assert.deepEqual(r, []);
});
