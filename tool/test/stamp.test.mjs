import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp, elementSource, position, tags } from '../stamp.mjs';

const html = `<!doctype html>
<html lang="hi">
<head>
<title>こんにちは</title>
<script>if (a > b) { document.write("<p>") }</script>
</head>
<body>
<!-- a <div> in a comment -->
<section id="s1" class="hero">
  <p data-x="a > b">Grüße, 東京 <b>1952</b></p>
  <svg viewBox="0 0 10 10"><use href="#petal"/><path d="M0 0Z" /></svg>
  <img src="a.jpg" alt="x">
  <div><div>inner</div></div>
</section>
</body>
</html>`;

const src = el => /data-cequ-src="([^"]+)"/.exec(el)?.[1];
const at = needle => {               // independent line/col for the first occurrence
  const off = html.indexOf(needle);
  return { line: html.slice(0, off).split('\n').length, col: off - html.lastIndexOf('\n', off - 1) };
};

test('position counts 1-based line and column', () => {
  const off = html.indexOf('<section');
  assert.deepEqual(position(html, off), { line: 9, col: 1 });
  assert.deepEqual(position(html, html.indexOf('<b>')), at('<b>'));
});

test('stamp marks body elements with file:line:col and leaves head alone', () => {
  const out = stamp(html, 'page.html');
  assert.match(out, /<body data-cequ-src="page.html:7:1">/);
  assert.match(out, /<section id="s1" class="hero" data-cequ-src="page.html:9:1">/);
  assert.match(out, /<p data-x="a > b" data-cequ-src="page.html:10:3">/);
  const b = at('<b>');
  assert.ok(out.includes(`<b data-cequ-src="page.html:${b.line}:${b.col}">1952</b>`));
  assert.match(out, /<title>こんにちは<\/title>/);
  assert.doesNotMatch(out, /<head[^>]*data-cequ-src/);
  assert.doesNotMatch(out, /<script[^>]*data-cequ-src/);
});

test('stamp handles self-closing svg children and void tags', () => {
  const out = stamp(html, 'page.html');
  const u = at('<use'), p = at('<path');
  assert.ok(out.includes(`<use href="#petal" data-cequ-src="page.html:${u.line}:${u.col}"/>`));
  assert.ok(out.includes(`<path d="M0 0Z"  data-cequ-src="page.html:${p.line}:${p.col}"/>`));
  assert.match(out, /<img src="a.jpg" alt="x" data-cequ-src="page.html:12:3">/);
});

test('comment and script contents are never treated as tags', () => {
  const names = [...tags(html)].filter(t => t.type === 'start').map(t => t.name);
  assert.ok(!names.includes('div') || names.filter(n => n === 'div').length === 2);
  assert.ok(!names.includes('p') || names.filter(n => n === 'p').length === 1);
});

test('stamping only adds attributes: removing them restores the original', () => {
  const out = stamp(html, 'page.html');
  assert.equal(out.replace(/ data-cequ-src="[^"]+"/g, ''), html);
});

test('elementSource returns byte-identical element text', () => {
  const p = elementSource(html, 10, 3);
  assert.equal(p.text, '<p data-x="a > b">Grüße, 東京 <b>1952</b></p>');
  const outer = elementSource(html, 13, 3);
  assert.equal(outer.text, '<div><div>inner</div></div>');
  assert.equal(elementSource(html, 12, 3).text, '<img src="a.jpg" alt="x">');
  const u = at('<use');
  assert.equal(elementSource(html, u.line, u.col).text, '<use href="#petal"/>');
  assert.equal(elementSource(html, 10, 4), null);
});

test('stamp and elementSource agree on every stamped element of a real-shaped page', () => {
  const out = stamp(html, 'page.html');
  for (const [, loc] of out.matchAll(/data-cequ-src="page.html:(\d+:\d+)"/g)) {
    const [line, col] = loc.split(':').map(Number);
    assert.ok(elementSource(html, line, col), `no element at ${loc}`);
  }
  assert.ok(src(out));
});
