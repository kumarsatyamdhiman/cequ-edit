// Everything that differs between macOS, Linux and Windows, in one place.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, rm } from 'node:fs/promises';
import { writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

const exec = promisify(execFile);
export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

// Run a project command line (dev server, build, production server) through the system shell
// (sh on macOS/Linux, cmd.exe on Windows) in its own process tree.
export function spawnCommand(command, { cwd, env, stdio }) {
  return spawn(command, { cwd, env, stdio, shell: true, detached: !IS_WIN, windowsHide: true });
}

// Stop a process and everything it started.
export function killTree(pid, force = false) {
  if (IS_WIN) { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); return; }
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
}

// Copy a folder or file for a preview / build copy: a copy-on-write clone where the disk supports it
// (APFS on macOS, btrfs/xfs on Linux), otherwise a plain copy. Writes in the copy never reach the source.
export async function cloneTree(src, dst) {
  const tries = IS_MAC ? [['cp', ['-cR', src, dst]]] : IS_WIN ? [] : [['cp', ['-a', '--reflink=auto', src, dst]]];
  for (const [cmd, args] of tries) {
    try { await exec(cmd, args); return; } catch { await rm(dst, { recursive: true, force: true }); }
  }
  await cp(src, dst, { recursive: true, verbatimSymlinks: true, force: true });
}

// Open a URL or file with the system's default app.
export function openPath(target) {
  if (IS_WIN) return exec('cmd', ['/c', `start "" "${target}"`], { windowsVerbatimArguments: true, windowsHide: true });
  return exec(IS_MAC ? 'open' : 'xdg-open', [target]);
}

// Show a file or folder in Finder / Explorer / the file manager.
export function revealPath(target) {
  if (IS_MAC) return exec('open', ['-R', target]);
  if (IS_WIN) return exec('explorer', [`/select,${target}`]).catch(() => {});   // explorer exits 1 even on success
  return exec('xdg-open', [dirname(target)]);
}

// Open a terminal window running `command` (the Claude subscription sign-in). Rejects when no terminal
// could be opened; the editor then shows the command with a Copy button instead.
export async function openTerminal(command, home) {
  if (IS_MAC) {
    // a .command file opened like a double-click: needs no macOS Automation permission
    const file = join(home, 'sign-in.command');
    writeFileSync(file, ['#!/bin/zsh -l', 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"', 'clear',
      'echo "Signing Claude Code in with your Claude subscription (no API billing)."',
      'echo "Your browser will open: approve the sign-in there."', 'echo', command, 'echo',
      'echo "Done. Go back to the editor and click Retry. You can close this window."', ''].join('\n'), { mode: 0o755 });
    chmodSync(file, 0o755);
    return exec('open', ['-a', 'Terminal', file]);
  }
  if (IS_WIN) return exec('cmd', ['/c', `start "Claude sign-in" cmd /k ${command}`], { windowsVerbatimArguments: true });
  const script = `${command}; echo; echo "Done. Go back to the editor and click Retry."; exec "\${SHELL:-sh}"`;
  for (const [cmd, ...args] of [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-x'], ['xterm', '-e']]) {
    try { await exec('sh', ['-c', `command -v ${cmd}`]); } catch { continue; }   // not installed: try the next one
    spawn(cmd, [...args, 'sh', '-c', script], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return;
  }
  throw new Error('No terminal app found.');
}
