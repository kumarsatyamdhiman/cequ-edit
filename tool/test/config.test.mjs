import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPage, detectBreakpoint, detectUploadsDir, sourceClasses, loadConfig, siteHome, listFiles } from '../config.mjs';

test('the start page is index.html, else the first top-level page', () => {
  assert.equal(detectPage(['about.html', 'index.html']), 'index.html');
  assert.equal(detectPage(['blog/post.html', 'home.html']), 'home.html');
  assert.equal(detectPage(['blog/post.html']), 'blog/post.html');
  assert.equal(detectPage([]), null);
});

test('the phone/desktop split is the most used max-width in the site CSS', () => {
  assert.deepEqual(detectBreakpoint(['@media (max-width: 900px) { a{} } @media (max-width:900px){b{}} @media (max-width: 1280px){c{}}']),
    { phone: '(max-width: 900px)', desktop: '(min-width: 901px)' });
  assert.deepEqual(detectBreakpoint(['@media (max-width: 600px){} @media (max-width: 1000px){}']),
    { phone: '(max-width: 600px)', desktop: '(min-width: 601px)' }, 'ties go to the one nearest 800px');
  assert.deepEqual(detectBreakpoint(['body{}']), { phone: '(max-width: 768px)', desktop: '(min-width: 769px)' });
});

test('source classes, uploads folder and file listing', () => {
  assert.deepEqual(sourceClasses(`<p class="a b"></p><i class='c'></i><b data-class="x"></b>`), ['a', 'b', 'c']);
  const dir = mkdtempSync(join(tmpdir(), 'cequ-cfg-'));
  assert.equal(detectUploadsDir(dir), 'uploads');
  mkdirSync(join(dir, 'images'));
  assert.equal(detectUploadsDir(dir), 'images/uploads');
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'x', 'a.html'), '');
  writeFileSync(join(dir, 'images', 'gallery.html'), '');
  assert.deepEqual(listFiles(dir, ['.html']), ['images/gallery.html']);
});

test('.cequ-edit.json overrides detection; guidance files are found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cequ-cfg-'));
  writeFileSync(join(dir, 'index.html'), '<style>@media (max-width: 700px){}</style>');
  writeFileSync(join(dir, 'PRODUCT.md'), '# p');
  let c = loadConfig(dir);
  assert.equal(c.page, 'index.html');
  assert.equal(c.breakpoints.phone, '(max-width: 700px)');
  assert.deepEqual(c.guidance, ['PRODUCT.md']);
  writeFileSync(join(dir, '.cequ-edit.json'), JSON.stringify({ page: 'home.html', rules: 'No em dashes', breakpoints: { phone: '(max-width: 900px)', desktop: '(min-width: 901px)' } }));
  c = loadConfig(dir);
  assert.equal(c.page, 'home.html');
  assert.deepEqual(c.rules, ['No em dashes']);
  assert.equal(c.breakpoints.desktop, '(min-width: 901px)');
  writeFileSync(join(dir, '.cequ-edit.json'), '{ bad');
  assert.throws(() => loadConfig(dir), /not valid JSON/);
});

test('each site gets its own runtime folder', () => {
  assert.notEqual(siteHome('/a/my site'), siteHome('/b/my site'));
  assert.match(siteHome('/x/My Site'), /\.cequ-edit[\\/]sites[\\/]my-site-[0-9a-f]{8}$/);
});

test('app mode: the app block, start route and public uploads', async () => {
  const { loadConfig, looksLikeApp } = await import('../config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cequ-cfg-app-'));
  mkdirSync(join(dir, 'public'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/index.css'), '@media (max-width: 640px) { a { color: red } }');
  writeFileSync(join(dir, 'package.json'), '{}');
  assert.equal(looksLikeApp(dir), true);
  writeFileSync(join(dir, '.cequ-edit.json'), JSON.stringify({ app: { command: 'npm run dev -- --port {port}', build: 'npm run build', out: 'dist' } }));
  const c = loadConfig(dir);
  assert.equal(c.appMode, true);
  assert.deepEqual(c.app, { command: 'npm run dev -- --port {port}', url: null, build: 'npm run build', out: 'dist', start: null });
  assert.equal(c.page, '/');
  assert.equal(c.uploadsDir, 'public/uploads');
  assert.equal(c.breakpoints.phone, '(max-width: 640px)');
});

test('a static site does not look like an app', async () => {
  const { looksLikeApp, loadConfig } = await import('../config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cequ-cfg-static-'));
  writeFileSync(join(dir, 'index.html'), '<p>x</p>');
  writeFileSync(join(dir, 'package.json'), '{}');
  assert.equal(looksLikeApp(dir), false);
  assert.equal(loadConfig(dir).appMode, false);
});
