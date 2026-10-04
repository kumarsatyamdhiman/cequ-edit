import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanClasses, attrsFromSnippet, parseSrc, normSelector, sheetFile } from '../overlay/capture.js';

test('with the page source classes known, script-added classes are dropped', () => {
  const source = new Set(['reveal', 'tilt-l', 'ph']);
  assert.equal(cleanClasses('reveal in tilt-l is-visible', source), 'reveal tilt-l');
  assert.equal(cleanClasses('ph cequ-typing', source), 'ph');
});

test('without source classes, common runtime class names are dropped', () => {
  assert.equal(cleanClasses('card is-active in visible', null), 'card');
  assert.equal(cleanClasses('', null), '');
});

test('attributes come from the source start tag exactly', () => {
  assert.deepEqual(attrsFromSnippet('<img src="a b.jpg" alt=\'x > y\' loading=lazy hidden style="object-position:72% 40%">'),
    { src: 'a b.jpg', alt: 'x > y', loading: 'lazy', hidden: '', style: 'object-position:72% 40%' });
  assert.deepEqual(attrsFromSnippet('<use href="#petal"/>'), { href: '#petal' });
  assert.deepEqual(attrsFromSnippet('not html'), {});
});

test('stylesheet URLs map to site files, also from previews', () => {
  assert.equal(sheetFile('http://127.0.0.1:8125/css/site.css'), 'css/site.css');
  assert.equal(sheetFile('http://127.0.0.1:8125/__cequ/preview/3/css/site%20main.css'), 'css/site main.css');
  assert.equal(sheetFile(null), null);
});

test('source locations parse, including file names with colons', () => {
  assert.deepEqual(parseSrc('index.html:212:7'), { file: 'index.html', line: 212, col: 7 });
  assert.deepEqual(parseSrc('a:b.html:3:1'), { file: 'a:b.html', line: 3, col: 1 });
  assert.equal(parseSrc('nope'), null);
});

test('selectors compare without CSSOM spacing differences', () => {
  assert.equal(normSelector('.a > .b,  .c'), normSelector('.a>.b,.c'));
});
