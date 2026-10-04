import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssRules, setDeclaration, appendRule, cssIndex } from '../css.mjs';

const CSS = ':root {\n  --accent: red;\n}\n/* a { b } */\n.t { color: blue; background-color: white; }\n.card {\n  padding: 4px;\n}\n@media (max-width: 900px) {\n  .t { color: red; }\n}\n';

test('rule ranges, lines and media', () => {
  assert.deepEqual(cssIndex(CSS), [
    { selector: ':root', line: 1, media: null }, { selector: '.t', line: 5, media: null },
    { selector: '.card', line: 6, media: null }, { selector: '.t', line: 10, media: '@media (max-width: 900px)' }]);
  const r = cssRules(CSS)[1];
  assert.equal(CSS.slice(r.open, r.close + 1), '{ color: blue; background-color: white; }');
});

test('setDeclaration replaces only the exact property', () => {
  const r = cssRules(CSS)[1];
  assert.match(setDeclaration(CSS, r, 'color', 'green'), /\.t \{ color: green; background-color: white; \}/);
  assert.match(setDeclaration(CSS, r, 'background-color', 'black'), /\.t \{ color: blue; background-color: black; \}/);
  assert.match(setDeclaration(CSS, cssRules(CSS)[0], '--accent', 'blue'), /:root \{\n  --accent: blue;\n\}/);
});

test('setDeclaration appends in the rule\'s own layout', () => {
  assert.match(setDeclaration(CSS, cssRules(CSS)[1], 'margin', '0'), /background-color: white; margin: 0; \}/);
  assert.match(setDeclaration(CSS, cssRules(CSS)[2], 'margin', '0'), /\.card \{\n  padding: 4px;\n  margin: 0;\n\}/);
});

test('appendRule adds one marker and media-wrapped rules', () => {
  let css = appendRule(CSS, '.x', { display: 'none' }, '(max-width: 900px)');
  css = appendRule(css, '.y', { color: 'red' });
  assert.equal(css.match(/\/\* CEQU-Edit \*\//g).length, 1);
  assert.match(css, /@media \(max-width: 900px\) \{ \.x \{ display: none; \} \}\n\.y \{ color: red; \}\n$/);
});
