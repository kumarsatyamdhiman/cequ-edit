# CEQU-Edit

Point-and-click visual editing for the websites and web apps you build, powered by [Claude Code](https://claude.com/claude-code).

Open your site in the browser, press **E**, and click any part of the page: a heading, a photo, a button. Say what should change (in any language), or use the built-in controls to swap a photo, pick a colour, edit text in place, align, resize or hide. Queue several changes, press **Edit ▸**, and Claude Code applies them to the right lines of your source code. You see a **Before / After** preview first, then **Approve** or **Reject**. Every approved change can be undone.

Simple changes (text, photos, colours, alignment on plain HTML sites) are applied instantly by CEQU-Edit itself, without Claude.

When you are done, **🏗 Build final site** runs your production build and gives you the files, a preview of the built site and a zip.

## Works with

- **Plain websites:** HTML, CSS and JavaScript files.
- **Web apps** with a local dev server: React, Next.js, Vue, Nuxt, Svelte / SvelteKit, Astro, Angular, Remix, Gatsby, Vite projects, Express and other Node servers with templates, Django, Flask, FastAPI, Rails, Laravel, plain PHP, Hugo, Jekyll, Eleventy, Go, .NET…

It runs on **macOS, Linux and Windows**, in any browser (Chrome, Safari, Firefox, Edge).

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- [git](https://git-scm.com)
- [Claude Code](https://claude.com/claude-code), signed in with your **Claude subscription** (Pro or Max)
- Optional on Linux and Windows: [ImageMagick](https://imagemagick.org), to resize uploaded photos and convert iPhone HEIC photos. macOS does this with built-in tools. Without it, JPG, PNG and WebP photos are used as uploaded.

**Billing:** CEQU-Edit only ever uses your own Claude subscription. It refuses to run with an API key or a Console account, and it never passes API keys to Claude.

**Privacy:** everything runs on your computer. The editor listens on `localhost` only, and your files are never uploaded anywhere by CEQU-Edit.

## Install

macOS / Linux:

```bash
git clone https://github.com/kumarsatyamdhiman/cequ-edit ~/.claude/skills/cequ-edit
node ~/.claude/skills/cequ-edit/tool/cequ.mjs --install
```

Windows (PowerShell):

```powershell
git clone https://github.com/kumarsatyamdhiman/cequ-edit "$HOME\.claude\skills\cequ-edit"
node "$HOME\.claude\skills\cequ-edit\tool\cequ.mjs" --install
```

The folder `~/.claude/skills/cequ-edit` makes it a Claude Code skill: Claude knows how to use it. The second command adds the `cequ` command to your terminal (open a new terminal window afterwards).

Update later with `git pull` in that folder.

## Use

```bash
cequ -edit path/to/your-site
```

The editor opens in your browser. Press **E**, click what you want to change, add it to the list, press **Edit ▸**, then approve or reject the preview.

- `cequ` on its own lists your sites and which ones are running.
- Stop the editor with **Ctrl+C** in its terminal window.

You can also just ask Claude Code: *"use CEQU-Edit on path/to/your-site"*.

### Web apps (React, Next, Flask, PHP…)

App projects need a one-time setup, so CEQU-Edit knows how to start your dev server and build your site. Ask Claude Code:

> set up CEQU-Edit for path/to/your-app

Claude writes a small `.cequ-edit.json` in your project, for example:

```json
{ "app": { "command": "npm run dev -- --port {port} --strictPort", "build": "npm run build", "out": "dist" } }
```

Then `cequ -edit path/to/your-app` works like for any site. Commands for common stacks are in [`references/stacks.md`](references/stacks.md).

### Git

CEQU-Edit keeps a history of your changes with git, which is what makes the previews and undo possible.

- If your folder isn't a git repository yet, it becomes one: a first "Baseline" commit, plus a `.gitignore` that keeps out dependencies, build output and `.env` secrets.
- In a repository you already use, each approved batch becomes one commit on your current branch.

## How it works

- **Plain sites:** a small local server serves your files and marks every element with its exact `file:line`, so a click maps to the precise line of code.
- **Apps:** CEQU-Edit runs your own dev server and sits in front of it as a proxy. Clicks are traced to the source through your framework's development info (React, Vue, Svelte, Astro) and a search of your project.
- **Previews:** each batch of changes is made in a separate copy, never in your files. Apps preview in a second, private copy of your app on the same address.
- **Claude Code:** runs in the background with file editing tools only (no shell), following a strict contract ([`tool/PROMPT.md`](tool/PROMPT.md)).

## Troubleshooting

| Problem | What to do |
|---|---|
| `cequ: command not found` | Open a new terminal window. On macOS/Linux, make sure `~/.local/bin` is on your PATH (the install command tells you). |
| A batch stops with "needs you to sign in" | Click **Sign in** in the editor, approve in your browser, then **Retry**. |
| "Your app isn't running" | Read the log shown on that page and fix the `app.command` in `.cequ-edit.json` (see `references/stacks.md`). |
| Content is invisible while editing | Your site hides it until scrolled: add an `editModeCss` rule to `.cequ-edit.json` (see `SKILL.md`). |

More in [`SKILL.md`](SKILL.md) and [`references/stacks.md`](references/stacks.md).

## Development

No dependencies to install. Run the tests (Node 22+):

```bash
cd tool && npm test
```

## License

[MIT](LICENSE)
