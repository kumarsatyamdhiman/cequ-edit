---
name: cequ-edit
description: "CEQU-Edit: point-and-click visual editing for websites and web apps the user builds, on any stack: static HTML/CSS/JS, React, Next.js, Vue, Nuxt, Svelte, Astro, Angular, Express/Node, Django, Flask, Rails, Laravel, PHP and more. Starts a local editor in front of the site or the app's own dev server: the user clicks components in the browser, describes the change (or uploads a replacement photo, picks a colour, edits text in place, removes/hides), queues several changes, presses Edit, and Claude Code applies them to the right source in a staging copy, with a before/after preview, approve/reject, one-click undo, and a Build final site button (production build, preview, zip). Use this whenever the user wants to visually edit, tweak or fix a web page or app UI by pointing at it, wants to build the final site after editing, asks for a click-to-edit / visual editor / 'select a component and tell you what to change' workflow for a site, mentions CEQU-Edit, or pastes a line like 'apply edit batch 3 in ~/.cequ-edit/...' (a CEQU-Edit hand-off). Runs on the user's Claude subscription only, never API billing."
---

# CEQU-Edit

A visual editing loop for websites and web apps. The user points at the page; Claude Code edits the code.

1. A small local server (Node, no installs) adds an editor overlay to the pages.
   - **Static sites:** it serves the files itself and stamps every element with its exact `file:line:col`.
   - **App projects:** it runs the project's own dev server and sits in front of it as a proxy. A click is traced to source through the framework's dev info (React ≤ 18, Svelte and Astro give exact lines; React 19 and Vue give the file), then through a project-wide search of the element's text, attributes and classes. The dialog shows `📍 file:line`, the possible places, or "🗄 Not in the code" when the words come from a database or API.
2. The user presses **E**, clicks components, and fills a dialog per component: an instruction, plus optional controls for photo replacement (HEIC ok, focal point, caption, "only here / everywhere"), colour (site colour variables or custom; this element / all like it / whole site), in-place text editing, and remove / hide on phone or desktop.
3. **Edit ▸** sends the batch. The server makes a staging copy (git worktree). **Instant changes are applied by CEQU-Edit itself** (see below); only the rest goes to Claude Code, run headless with a strict contract (`tool/PROMPT.md`).
4. The preview opens by itself: Before/After toggle, phone view, code diff. Apps preview in a private second copy of the app on the same address. **Approve** merges into the live site as one git commit; **Reject** discards; **History → Undo** reverts any approved batch exactly.
5. **🏗 Build final site** (apps) runs the production build in a clean copy, puts the output in the project's usual folder (e.g. `dist/`), and offers **Preview built site**, **Download zip**, **Show folder** (Finder / Explorer), or **Fix with Claude** when the build fails. Static sites get **⬇ Download final site**: a zip of the approved site without the editor's files.

## Instant changes (no Claude)

A change that uses only the dialog's controls, with no written instruction, is applied by CEQU-Edit directly from the exact source position: no Claude call, no plan usage, preview ready in about a second. The dialog shows **⚡ Instant** or **✦ Claude** for each change, and the list shows the split.

| Control | What CEQU-Edit writes itself (`tool/direct.mjs`) |
|---|---|
| ✏️ Text | swaps the element's inner HTML exactly |
| 🖼 Photo | `src`, `width`/`height`, `alt`, `object-position`; the figure's caption; "everywhere" across all pages with per-page relative paths |
| 📐 Layout | align left / centre / right, width (natural, full, ¾, ½, ⅓), photo fit (fill / show whole), focal point on the existing photo |
| 🎨 Colour | this element (inline), all like it (edits the shared rule), whole-site variable (edits `:root`), written in the stylesheet's own colour format (e.g. hex → OKLCH) |
| 🗑 Remove | deletes the element's lines, or hides it on phone / desktop |

**App projects:** only text, photos with a literal path under `public/` or `static/`, and whole-site colour variables in a `.css` file are instant. They are instant only when the exact source position is known, and the text must have no markup or template characters. Text works in JSX, Vue, Svelte, Astro, EJS, Jinja, Blade, ERB, PHP and JSON. Layout, remove, element colours and anything found only as "possible places" go to Claude.

All-screens styles go inline on the element; phone-only or desktop-only styles add a short class (`cq-xxxxxx`) and a media rule at the end of the element's stylesheet under a `/* CEQU-Edit */` marker. Anything typed in the instruction box, script-generated elements, or a change CEQU-Edit cannot do with certainty (for example the source changed since the click) goes to Claude instead; a batch can mix both, and Claude only sees its own items.

## When it fits

- **Static sites:** plain files served as-is (`.html` pages, linked `.css` / `.js`, images). Multi-page sites and subfolders work.
- **App projects:** any stack whose UI is HTML in a browser served by a local dev server. That includes Vite (React, Vue, Svelte…), Next, Nuxt, SvelteKit, Astro, Remix, Angular, Gatsby and CRA. It also covers Express or other Node servers with templates, Django, Flask, FastAPI, Rails, Laravel, plain PHP, Hugo, Jekyll, Eleventy, Go and .NET.
- **Not for:** native mobile or desktop UIs (React Native, Flutter, Electron windows), or the inside of a `<canvas>` / WebGL scene (the canvas element itself can be selected). Say so and offer normal instructions instead.

## The `cequ` command

`cequ -edit <folder>` starts the editor for that site or app and opens it in the default browser (Chrome, Safari and Firefox all work: it is a normal page on localhost). `cequ` alone lists the sites edited before and which are running. One editor per site: a second `cequ -edit` on the same folder just opens the running one. Stop with Ctrl+C. Install or repair the command with `node ~/.claude/skills/cequ-edit/tool/cequ.mjs --install` (links `~/.local/bin/cequ`). App projects still need their `app` block first (below).

## Starting it for an app project

Read `references/stacks.md`, then:
1. Use the project's top folder, which must be the top of its git repository if it already is one.
2. Write the `app` block in `.cequ-edit.json`: `command` (dev server with `{port}`, one that reloads on file changes), and `build` + `out` (or `start`) so Build final site works. `stacks.md` lists them per stack.
3. Tell the owner about git (see stacks.md: "Things to tell the owner"), then add the launch entry below with `--site <project folder>` and start it.
4. The server prints `http://localhost:<port>/`. Give it to the owner with the same short how-to as for static sites, plus: "When everything is approved, press 🏗 Build final site."

If the server says "This looks like an app project. Ask Claude: set up CEQU-Edit for this project", the `app` block is missing: do steps 1–3.

## Starting it for a static site

1. Find the site folder (the one with the `.html` pages).
2. Start the server. In the Claude desktop app, prefer a preview launch entry so the user can open it with one click. Add to the project's `.claude/launch.json`:

   ```json
   { "name": "cequ-edit-<site>", "runtimeExecutable": "node",
     "runtimeArgs": ["<HOME>/.claude/skills/cequ-edit/tool/server.mjs", "--site", "<absolute site folder>"],
     "port": 8125 }
   ```

   (use the real home path; `~` is not expanded there) and start it with `preview_start`. Elsewhere, run it in the background:

   ```bash
   node ~/.claude/skills/cequ-edit/tool/server.mjs --site <site folder> [--page about.html] [--port 8125]
   ```

   With no `--site` it uses the current folder. If the port is busy it takes the next free one and prints the URL.
3. **Tell the user before the first start** that the site folder becomes a git repository (branch `main` = the live site, a "Baseline" commit, and two lines added to `.gitignore`). That history is what makes preview diffs and undo possible. If the folder is already a git repo, CEQU-Edit uses it and commits only when the user approves a batch (any uncommitted hand edits are committed first as "Manual edits").
4. Give the user the printed URL and the short how-to: press **E**, click a part of the page, describe or use a control, **Add to list**, repeat, **Edit ▸**, then Approve or Reject in the preview.

## Per-site settings (optional): `.cequ-edit.json`

Everything is detected automatically: start page (`index.html`, else the first page), phone/desktop split (the most used `max-width` in the site's media queries), upload folder (`assets/img/uploads`, `images/uploads`, … or `uploads`), and the colour variables in `:root`. Project guidance files `PRODUCT.md`, `DESIGN.md`, `CLAUDE.md`, `AGENTS.md` are passed to every batch automatically.

Create `.cequ-edit.json` in the site folder only to override or add:

| Key | Use |
|---|---|
| `page` | start page, e.g. `"home.html"` |
| `breakpoints` | `{ "phone": "(max-width: 900px)", "desktop": "(min-width: 901px)" }` |
| `uploadsDir` | where uploaded photos are copied, e.g. `"assets/img/uploads"` |
| `editModeCss` | CSS applied only while edit mode is on: hide custom cursors or intro overlays, force scroll-revealed content visible |
| `tokenLabels` | friendly names for colour variables: `{ "--accent": "Brand orange" }` |
| `rules` | standing instructions for every batch: `["Write colours in OKLCH", "No em dashes in visible text"]` |
| `app` | app projects only: `{ "command", "build", "out", "start", "url" }`, see `references/stacks.md` |

Add `editModeCss` when the site has things that hide content until scrolled (reveal-on-scroll classes), a custom cursor, or an intro/curtain layer. Look at the site's CSS for the hidden-state rules and write the visible state, for example:

```json
{ "editModeCss": ".cursor, .intro { display: none !important; } .reveal { opacity: 1 !important; transform: none !important; }" }
```

Restart the server after editing this file.

## Applying a hand-off in chat

When a batch fails, the user may click "Or apply it manually in a Claude chat" and paste a line like:
`apply edit batch 7 in ~/.cequ-edit/sites/<site>/stage/7 (follow …/tool/PROMPT.md)`

Then:
1. Read that `PROMPT.md` and follow it exactly.
2. Read `.cequ-batch.json` in that stage folder.
3. Make the edits **in the stage folder only**, never in the live site folder.
4. Write `.cequ-result.json` there.

Do not commit: the user approves in the browser, which switches to the preview by itself once the result file appears.

## Sign-in and billing: subscription only

- Before every run the server checks `claude auth status`. If Claude Code is not signed in with a Claude subscription (a Console / API login, or an API key in Claude's settings), the batch stops and nothing is sent.
- The background Claude never receives `ANTHROPIC_*` variables (API keys, tokens, proxy URLs), nor the desktop session's own login (a session login it could not renew).
- If a batch stops with "needs you to sign in", the panel's **Sign in** button opens a terminal window with `claude auth login --claudeai`. The user approves in the browser, then clicks **Retry**. If Terminal can't be opened, the panel shows the command with a Copy button.
- For a sign-in that lasts about a year, the user can run `claude setup-token` and save the printed `sk-ant-oat…` token into `~/.cequ-edit/claude-token` themselves. Only that token form is accepted. Never type or handle the token for them.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No editor button on the page | The page was opened as a file or from another server. Open the URL the CEQU-Edit server printed. |
| "The editor server was restarted" | Click **Reload this page** (the editor token persists, but pages opened before an upgrade may be stale). |
| Batch **Stopped**, sign-in message | Click **Sign in** → approve → **Retry** (see above). |
| Clicking selects a small piece | Use **↑ / ↓** (or `[` `]`) in the dialog to move to the parent or child. |
| Content invisible in edit mode | The site hides it until scrolled; add an `editModeCss` rule. |
| Need Claude's full output for a batch | `~/.cequ-edit/sites/<site>-<hash>/logs/<batch>.log` |
| Preview says "gone" | That batch was approved or rejected already. |
| App page says "Your app isn't running" | Read the log on that page, fix `app.command` (stacks.md), press **Restart**. |
| App preview bar: "the preview copy could not start" | The app can't run twice (fixed port, docker). Code changes, Approve and Undo still work; see stacks.md. |
| Build failed | **Fix with Claude** in the build box, or read `~/.cequ-edit/sites/<site>/logs/build.log`. |

## Files

| Path | Role |
|---|---|
| `tool/cequ.mjs` | the `cequ` command (`--install` puts it on PATH) |
| `tool/platform.mjs` | macOS / Linux / Windows differences (shell, stopping processes, copies, opening files, terminal) |
| `tool/server.mjs` | local server, API, live reload, sign-in launcher, app mode wiring |
| `tool/proxy.mjs` | app mode: forwards to the dev server, injects the editor, passes WebSockets |
| `tool/apps.mjs` | app processes (live, preview, production) and the cloned preview / build copies |
| `tool/locate.mjs` | app mode: finds the source of a clicked element |
| `tool/build.mjs` | Build final site: build copy, output copy-back, zip, Built view server |
| `tool/config.mjs` | per-site detection + `.cequ-edit.json` |
| `tool/stamp.mjs` | `file:line:col` stamping and exact element extraction |
| `tool/images.mjs` | photo validation and resizing (macOS `sips`, else ImageMagick, else kept as uploaded) |
| `tool/runner.mjs` | staging worktree, instant-first routing, subscription check, Claude run, approve / reject / undo |
| `tool/direct.mjs` | instant edits (text, photo, layout, colour, remove) without Claude |
| `tool/css.mjs` | stylesheet scanning and declaration edits |
| `tool/PROMPT.md` | the contract Claude follows for every batch |
| `tool/overlay/` | the in-page editor (selection, dialog, list, preview bar, history) |
| `references/stacks.md` | app setup: `app` block, commands per stack, troubleshooting |

Runtime data per site: `~/.cequ-edit/sites/<name>-<hash>/` (staging copies, preview and build copies, uploads, batch state, logs, editor token).

Requirements: macOS, Linux or Windows; Node 20+; git; Claude Code signed in with a Claude subscription. Photos are resized (and iPhone HEIC converted) by macOS's built-in `sips`, or by ImageMagick on Linux/Windows when installed; without it, JPG/PNG/WebP are used as uploaded.

To check the tool after changing it: `cd ~/.claude/skills/cequ-edit/tool && npm test`.
