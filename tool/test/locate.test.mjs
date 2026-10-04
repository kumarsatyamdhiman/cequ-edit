import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createLocator, normalizePath } from '../locate.mjs';
import { ensureRepo } from '../runner.mjs';

let site, home, loc;
const FILES = {
  'src/components/Hero.jsx': `export default function Hero() {\n  return (\n    <section className="hero">\n      <h1 className="hero-title">Welcome back</h1>\n      <img src="/img/team.jpg" alt="Our team" />\n      <p className="lead">{subtitle}</p>\n    </section>\n  );\n}\n`,
  'src/components/Card.vue': `<template>\n  <div class="card">\n    <h2 class="card-title">Pricing plans</h2>\n    <button class="btn">Buy now</button>\n  </div>\n</template>\n`,
  'src/routes/About.svelte': `<main>\n  <h1>About us</h1>\n  <button class="btn">Buy now</button>\n</main>\n`,
  'views/contact.ejs': `<form>\n  <input placeholder="Your email" name="email">\n  <button class="btn">Send</button>\n</form>\n`,
  'templates/base.html': `<nav>\n  <a href="/blog" title="Read the blog">Blog</a>\n</nav>\n`,
  'src/i18n/en.json': `{\n  "cta": "Start your free trial"\n}\n`,
  'content/post.md': `# Hello world\n\nA post about gardens.\n`,
  'public/img/team.jpg': 'jpg',
  'package-lock.json': '{"Welcome back": 1}',
};

before(async () => {
  site = mkdtempSync(join(tmpdir(), 'cequ-loc-'));
  home = mkdtempSync(join(tmpdir(), 'cequ-loc-home-'));
  for (const [f, t] of Object.entries(FILES)) { mkdirSync(join(site, dirname(f)), { recursive: true }); writeFileSync(join(site, f), t); }
  await ensureRepo(site, { app: true });
  loc = createLocator({ siteDir: site, home });
});

test('normalising framework paths', () => {
  const o = { siteDir: site, roots: [join(home, 'preview')], stageRoot: join(home, 'stage') };
  assert.equal(normalizePath(join(site, 'src/components/Hero.jsx'), o), 'src/components/Hero.jsx');
  assert.equal(normalizePath('http://localhost:5173/src/components/Hero.jsx?t=123', o), 'src/components/Hero.jsx');
  assert.equal(normalizePath(`/@fs${site}/src/components/Hero.jsx`, o), 'src/components/Hero.jsx');
  assert.equal(normalizePath(join(home, 'preview', 'src/x.js'), o), 'src/x.js');
  assert.equal(normalizePath(join(home, 'stage', '7', 'src/x.js'), o), 'src/x.js');
  assert.equal(normalizePath('/projects/x/node_modules/react/index.js', o), null);
  assert.equal(normalizePath('/elsewhere/file.js', o), null);
  const win = { siteDir: 'C:\\proj', roots: [], stageRoot: 'C:\\Users\\x\\.cequ-edit\\stage' };
  assert.equal(normalizePath('C:\\proj\\src\\App.jsx', win), 'src/App.jsx', 'Windows paths');
  assert.equal(normalizePath('c:/proj/src/App.jsx', win), 'src/App.jsx');
  assert.equal(normalizePath('/@fs/C:/proj/src/App.jsx', win), 'src/App.jsx');
  assert.equal(normalizePath('C:\\Users\\x\\.cequ-edit\\stage\\4\\src\\a.js', win), 'src/a.js');
});

test('an exact framework hint is checked against the file', async () => {
  const r = await loc.locate({ hint: { file: join(site, 'src/components/Hero.jsx'), line: 4, col: 7, exact: true }, tag: 'h1', ownText: ['Welcome back'], classes: ['hero-title'] });
  assert.equal(r.kind, 'exact');
  assert.equal(r.src, 'src/components/Hero.jsx:4:7');
  assert.deepEqual(r.literal, { text: true, src: false });
  assert.equal(r.textInCode, true);
  const off = await loc.locate({ hint: { file: 'src/components/Hero.jsx', line: 5, exact: true }, tag: 'h1', ownText: ['Welcome back'] });
  assert.equal(off.src, 'src/components/Hero.jsx:5:1', 'one line off still verifies (±3 lines)');
});

test('a wrong hint becomes a candidate, never exact', async () => {
  const r = await loc.locate({ hint: { file: 'content/post.md', line: 1, exact: true }, tag: 'button', ownText: ['Buy now'], classes: ['btn'] });
  assert.notEqual(r.src, 'content/post.md:1:1');
  assert.equal(r.kind, 'candidates');
  assert.ok(r.candidates.some(c => c.file === 'content/post.md'));
  assert.ok(r.candidates.some(c => c.file === 'src/components/Card.vue' && c.why.includes('text')));
});

test('text found once in the project is exact (lockfiles ignored)', async () => {
  const r = await loc.locate({ tag: 'h2', ownText: ['Pricing   plans'] });
  assert.equal(r.src, 'src/components/Card.vue:3:28');
  const i18n = await loc.locate({ tag: 'a', ownText: ['Start your free trial'] });
  assert.equal(i18n.src, 'src/i18n/en.json:2:11');
  assert.equal(i18n.literal.text, true);
});

test('attributes and rare classes rank candidates', async () => {
  const r = await loc.locate({ tag: 'input', attributes: { placeholder: 'Your email', name: 'email' }, classes: [] });
  assert.equal(r.kind, 'candidates');
  assert.equal(r.candidates[0].file, 'views/contact.ejs');
  const link = await loc.locate({ tag: 'a', ownText: [], attributes: { href: '/blog', title: 'Read the blog' } });
  assert.equal(link.candidates[0].file, 'templates/base.html');
  assert.equal(link.textInCode, null);
});

test('text that is not in the code comes from data', async () => {
  const r = await loc.locate({ tag: 'p', ownText: ['Latest prices from the API'] });
  assert.equal(r.kind, 'none');
  assert.equal(r.textInCode, false);
});

test('an image src in public/ is a literal for instant photo swaps', async () => {
  const r = await loc.locate({ hint: { file: 'src/components/Hero.jsx', line: 5, exact: true }, tag: 'img', ownText: [], attributes: { src: '/img/team.jpg', alt: 'Our team' } });
  assert.equal(r.src, 'src/components/Hero.jsx:5:1');
  assert.equal(r.literal.src, true);
});

test('text mixing literal words with computed values is still found in the code', async () => {
  const r = await loc.locate({ tag: 'button', ownText: ['Send 3 items'] });
  assert.equal(r.textInCode, true);
  assert.equal(r.candidates[0].file, 'views/contact.ejs');
});

test('a hint shifted by a dev-server transform finds the nearest matching tag; a tag alone is not proof', async () => {
  const r = await loc.locate({ hint: { file: 'src/components/Hero.jsx', line: 4 + 19, col: 7, exact: true }, tag: 'h1', ownText: ['Welcome back'] });
  assert.equal(r.src, 'src/components/Hero.jsx:4:7');
  const weak = await loc.locate({ hint: { file: 'src/components/Card.vue', line: 4, exact: true }, tag: 'button', ownText: ['Checkout'], classes: [] });
  assert.notEqual(weak.kind, 'exact', 'same tag, but no text, attribute or rare class there');
});
