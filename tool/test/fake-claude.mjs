// Stand-in for `claude -p` in tests: applies text items literally and asks when told "ASK".
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === 'auth') {                       // `claude auth status --json`
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: process.env.FAKE_AUTH_METHOD || 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}
const resume = args.includes('--resume');
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const mode = process.env.FAKE_CLAUDE_MODE;

out({ type: 'system', subtype: 'init', session_id: resume ? args[args.indexOf('--resume') + 1] : 'fake-session-1' });
if (mode === 'sleep') setInterval(() => {}, 1000);
else if (mode === 'expired') {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' }] } });
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}' });
}
else if (mode === 'silent') out({ type: 'result', subtype: 'success', result: 'done' });
else {
  const batch = JSON.parse(readFileSync('.cequ-batch.json', 'utf8'));
  const results = [];
  for (const item of batch.items) {
    const file = item.target?.src ? item.target.src.split(':')[0] : batch.page;
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `Working on item ${item.id}` }, { type: 'tool_use', name: 'Edit', input: { file_path: `${process.cwd()}/${file}` } }] } });
    if (/ASK/.test(item.instruction || '') && !(batch.answers || []).length) {
      results.push({ id: item.id, status: 'needs_input', summary: '', files: [], question: 'Which heading do you mean?' });
      continue;
    }
    const t = item.payload?.text;
    if (t) writeFileSync(file, readFileSync(file, 'utf8').replace(t.from, t.to));
    results.push({ id: item.id, status: 'done', summary: `text → ${t?.to ?? 'nothing'}`, files: [`${file}:1`], question: null, reason: null });
  }
  writeFileSync('.cequ-result.json', JSON.stringify({ items: results }));
  out({ type: 'result', subtype: 'success', session_id: 'fake-session-1', result: 'ok' });
}
