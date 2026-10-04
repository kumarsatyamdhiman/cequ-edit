import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceHint, projectFrame } from '../overlay/source.js';

// minimal fake elements: closest() by attribute, parentElement chain
function el(attrs = {}, extra = {}, parent = null) {
  const node = { parentElement: parent, getAttribute: a => attrs[a] ?? null, ...extra };
  node.closest = sel => {
    const a = /^\[([\w-]+)\]$/.exec(sel)[1];
    for (let n = node; n; n = n.parentElement) if (n.getAttribute(a) != null) return n;
    return null;
  };
  return node;
}

test('static stamps and Astro attributes are exact', () => {
  assert.deepEqual(sourceHint(el({ 'data-cequ-src': 'index.html:3:1' })).hint, { file: 'index.html', line: 3, col: 1, exact: true });
  const astro = el({}, {}, el({ 'data-astro-source-file': '/p/src/pages/index.astro', 'data-astro-source-loc': '12:5' }));
  assert.deepEqual(sourceHint(astro).hint, { file: '/p/src/pages/index.astro', line: 12, col: 5, exact: true });
});

test('Svelte meta on the element or an ancestor', () => {
  const parent = el({}, { __svelte_meta: { loc: { file: 'src/routes/+page.svelte', line: 8, column: 2 } } });
  assert.deepEqual(sourceHint(el({}, {}, parent)).hint, { file: 'src/routes/+page.svelte', line: 8, col: 2, exact: true });
});

test('React 18: _debugSource, library components climb to the project usage, component chain', () => {
  const App = function App() {}, Hero = function Hero() {}, Button = function MuiButton() {};
  const appFiber = { type: App, return: null };
  const heroFiber = { type: Hero, return: appFiber };
  const buttonFiber = { type: Button, return: heroFiber, _debugSource: { fileName: '/p/src/Hero.jsx', lineNumber: 9, columnNumber: 7 } };
  const host = { type: 'button', return: buttonFiber, _debugOwner: buttonFiber, _debugSource: { fileName: '/p/node_modules/@mui/Button.js', lineNumber: 1 } };
  const r = sourceHint(el({}, { '__reactFiber$abc': host }));
  assert.deepEqual(r.hint, { file: '/p/src/Hero.jsx', line: 9, col: 7, exact: true });
  assert.deepEqual(r.components, ['App', 'Hero', 'MuiButton']);
});

test('React 19: first project frame of _debugStack, file only', () => {
  const stack = 'Error: react-stack-top-frame\n    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)\n    at Hero (http://localhost:5173/src/components/Hero.tsx?t=171:22:9)';
  assert.equal(projectFrame(stack), 'http://localhost:5173/src/components/Hero.tsx?t=171');
  const host = { type: 'h1', return: { type: function Hero() {}, return: null }, _debugStack: { stack } };
  assert.deepEqual(sourceHint(el({}, { '__reactFiber$x': host })).hint, { file: 'http://localhost:5173/src/components/Hero.tsx?t=171', exact: false });
});

test('Vue: component file and names', () => {
  const root = { type: { name: 'App', __file: '/p/src/App.vue' }, parent: null };
  const card = { type: { __name: 'Card', __file: '/p/src/components/Card.vue' }, parent: root };
  const r = sourceHint(el({}, { __vueParentComponent: card }));
  assert.deepEqual(r.hint, { file: '/p/src/components/Card.vue', exact: false });
  assert.deepEqual(r.components, ['App', 'Card']);
});

test('no framework info: no hint', () => {
  assert.deepEqual(sourceHint(el()), { hint: null, components: [] });
});
