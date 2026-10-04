#!/usr/bin/env node
// The `cequ` command (linked into ~/.local/bin by `node cequ.mjs --install`).
//   cequ -edit <folder>   start CEQU-Edit on that site or app and open it in your browser
//   cequ                  list the sites you have edited with CEQU-Edit
import { existsSync, readdirSync, readFileSync, mkdirSync, symlinkSync, rmSync, chmodSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'server.mjs');
const SITES = join(homedir(), '.cequ-edit', 'sites');
const args = process.argv.slice(2);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const read = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

const USAGE = `
  cequ -edit <folder>      Start CEQU-Edit on a website or app folder and open it in your browser.
                           Options: --port 8125, --page about.html (static sites), --no-open
  cequ                     List the sites you have edited.

  Stop the editor with Ctrl+C in its Terminal window.
  App projects (React, Next, Flask, PHP…) need a one-time setup: ask Claude
  "set up CEQU-Edit for <folder>".
`;

if (['-edit', '--edit', 'edit'].includes(args[0])) {
  const rest = args.slice(1);
  const folder = rest[0] && !rest[0].startsWith('--') ? rest.shift() : '.';
  const open = !rest.includes('--no-open');
  // run the server's own CLI in this process
  process.argv = [process.argv[0], SERVER, '--site', resolve(folder), ...rest.filter(a => a !== '--no-open'), ...(open ? ['--open'] : [])];
  await import(SERVER);
} else if (args[0] === '--install') {
  const me = fileURLToPath(import.meta.url);
  if (process.platform === 'win32') {
    // a cequ.cmd next to npm's own commands, a folder Node's installer puts on PATH
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const dir = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', shell: true }).trim();
    writeFileSync(join(dir, 'cequ.cmd'), `@echo off\r\nnode "${me}" %*\r\n`);
    console.log(`Installed: ${join(dir, 'cequ.cmd')}\nOpen a new terminal and try: cequ -edit <folder>`);
  } else {
    const bin = join(homedir(), '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const link = join(bin, 'cequ');
    try { if (lstatSync(link)) rmSync(link); } catch { /* none yet */ }
    chmodSync(me, 0o755);
    symlinkSync(me, link);
    console.log(`Installed: ${link}\nTry: cequ -edit <folder>`);
    if (!String(process.env.PATH).split(':').includes(bin)) {
      console.log(`\n${bin} is not on your PATH yet. Add this line to ~/.zshrc or ~/.bashrc, then open a new terminal:\n  export PATH="$HOME/.local/bin:$PATH"`);
    }
  }
} else if (!args.length || args[0] === 'list') {
  const rows = (existsSync(SITES) ? readdirSync(SITES) : []).map(d => {
    const site = read(join(SITES, d, 'site.json'))?.site;
    const run = read(join(SITES, d, 'server.json'));
    return site && { site, url: run && alive(run.pid) ? run.start : null };
  }).filter(Boolean).filter(r => existsSync(r.site));
  if (!rows.length) console.log('\n  No sites yet. Start one with: cequ -edit <folder>');
  else {
    console.log('\n  Your CEQU-Edit sites:\n');
    for (const r of rows) console.log(`  ${r.url ? '●' : '○'} ${r.site.replace(homedir(), '~')}${r.url ? `   running → ${r.url}` : ''}`);
    console.log('\n  Start one with: cequ -edit <folder>');
  }
  console.log(USAGE);
} else {
  console.log(USAGE);
  process.exit(args[0] === '-h' || args[0] === '--help' ? 0 : 1);
}
