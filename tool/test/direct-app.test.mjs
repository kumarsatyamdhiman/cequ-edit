import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDirect } from '../direct.mjs';
import { isDirect, plainText } from '../overlay/kinds.js';

const JSX = `export default function Hero() {
  return (
    <section className="hero">
      <h1 className="hero-title">Welcome back</h1>
      <p title='Say "hi"'>It's great</p>
      <img src="/img/team.jpg" alt="Our team" />
    </section>
  );
}
`;
const I18N = '{\n  "cta": "Start your free trial"\n}\n';
const CSS = ':root {\n  --brand: #ff0000;\n}\n';
let dir;
const read = f => readFileSync(join(dir, f), 'utf8');
const located = (text = true, src = false) => ({ kind: 'exact', literal: { text, src }, candidates: [], textInCode: true });
const textItem = (src, fromPlain, plain, extra = {}) => ({ id: 1, kind: 'text', screens: 'all', instruction: '',
  target: { src, located: located(), attributes: {}, ...extra }, payload: { text: { from: fromPlain, to: plain, fromPlain, plain } } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cequ-dapp-'));
  for (const d of ['src/components', 'src/i18n', 'public/img', 'public/uploads']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'src/components/Hero.jsx'), JSX);
  writeFileSync(join(dir, 'src/i18n/en.json'), I18N);
  writeFileSync(join(dir, 'src/index.css'), CSS);
  writeFileSync(join(dir, 'public/img/team.jpg'), 'old');
  writeFileSync(join(dir, 'public/uploads/new.jpg'), 'new');
});

test('isDirect: static unchanged; app needs an exact place and literal values', () => {
  assert.equal(plainText('Hello, world!'), true);
  assert.equal(plainText('{name}'), false);
  const app = textItem('src/components/Hero.jsx:4:7', 'Welcome back', 'Hello again');
  assert.equal(isDirect(app), true);
  assert.equal(isDirect({ ...app, target: { ...app.target, src: null } }), false, 'candidates go to Claude');
  assert.equal(isDirect({ ...app, payload: { text: { ...app.payload.text, plain: '{x}' } } }), false);
  const icon = { from: 'Go<svg width="14"><path d="M1"></path></svg>', to: 'Go now<svg width="14"><path d="M1"></path></svg>', fromPlain: 'Go', plain: 'Go now' };
  assert.equal(isDirect({ ...app, payload: { text: icon } }), true, 'text next to an icon: only the words changed');
  assert.equal(isDirect({ ...app, payload: { text: { ...icon, to: '<b>Go now</b><svg width="14"><path d="M1"></path></svg>' } } }), false, 'formatting added');
  assert.equal(isDirect({ ...app, payload: { layout: { align: 'center' } } }), false, 'layout goes to Claude in app mode');
  assert.equal(isDirect({ ...app, payload: { color: [{ property: 'color', to: '#000000', scope: 'element' }] } }), false);
  assert.equal(isDirect({ ...app, payload: { color: [{ property: 'color', to: '#000000', scope: 'token', token: '--brand' }] } }), true);
  assert.equal(isDirect({ kind: 'text', instruction: '', target: { src: 'index.html:3:1' }, payload: { layout: { align: 'center' } } }), true, 'static');
});

test('text in JSX is replaced in place', async () => {
  const [r] = await applyDirect({ dir, items: [textItem('src/components/Hero.jsx:4:7', 'Welcome back', 'Hello again')] });
  assert.equal(r.status, 'done', r.reason);
  assert.match(read('src/components/Hero.jsx'), /<h1 className="hero-title">Hello again<\/h1>/);
});

test('text inside a JSON string: quotes of that string are refused', async () => {
  const [bad] = await applyDirect({ dir, items: [textItem('src/i18n/en.json:2:11', 'Start your free trial', 'Say "go"')] });
  assert.equal(bad.status, 'fallback');
  assert.match(bad.reason, /would end the string/);
  const [ok] = await applyDirect({ dir, items: [textItem('src/i18n/en.json:2:11', 'Start your free trial', "Start today, it's free")] });
  assert.equal(ok.status, 'done', ok.reason);
  assert.equal(JSON.parse(read('src/i18n/en.json')).cta, "Start today, it's free");
});

test('text that is gone or ambiguous falls back to Claude', async () => {
  const [r] = await applyDirect({ dir, items: [textItem('src/components/Hero.jsx:4:7', 'Not there', 'x')] });
  assert.equal(r.status, 'fallback');
  assert.match(r.reason, /changed since it was selected/);
});

test('photo with a literal public path: upload path swapped, alt updated', async () => {
  const item = { id: 1, kind: 'image', screens: 'all', instruction: '',
    target: { src: 'src/components/Hero.jsx:6:7', located: located(false, true), attributes: { src: '/img/team.jpg', alt: 'Our team' } },
    payload: { image: { file: 'public/uploads/new.jpg', alt: 'The whole team', scope: 'here', focal: '50% 50%' } } };
  assert.equal(isDirect(item), true);
  const [r] = await applyDirect({ dir, items: [item] });
  assert.equal(r.status, 'done', r.reason);
  assert.match(read('src/components/Hero.jsx'), /<img src="\/uploads\/new\.jpg" alt="The whole team" \/>/);
});

test('upload outside the public folder falls back', async () => {
  const item = { id: 1, kind: 'image', screens: 'all', instruction: '',
    target: { src: 'src/components/Hero.jsx:6:7', located: located(false, true), attributes: { src: '/img/team.jpg', alt: 'Our team' } },
    payload: { image: { file: 'uploads/new.jpg', alt: 'Our team', scope: 'here' } } };
  const [r] = await applyDirect({ dir, items: [item] });
  assert.equal(r.status, 'fallback');
});

test('site colour variable in a tracked .css file', async () => {
  const item = { id: 1, kind: 'color', screens: 'all', instruction: '',
    target: { src: 'src/components/Hero.jsx:4:7', located: located(), cssRules: [{ at: 'src/index.css' }] },
    payload: { color: [{ property: 'color', to: '#00ff00', scope: 'token', token: '--brand' }] } };
  const [r] = await applyDirect({ dir, items: [item] });
  assert.equal(r.status, 'done', r.reason);
  assert.match(read('src/index.css'), /--brand: #00ff00;/);
});
