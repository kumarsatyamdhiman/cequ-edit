# Setting up CEQU-Edit for an app project

Read this when the project is not plain `.html` files: React, Vue, Svelte, Next, Astro, Angular, Express, Django, Flask, Rails, Laravel, PHP, and so on. You write the `app` block of `.cequ-edit.json` once per project. CEQU-Edit has no stack detection of its own: you choose the commands, because you can read the project.

## The `app` block

```json
{
  "app": {
    "command": "npm run dev -- --port {port} --strictPort",
    "build": "npm run build",
    "out": "dist",
    "start": null,
    "url": null
  }
}
```

| Key | Write |
|---|---|
| `command` | The dev server for the UI. Write it so it works in this computer's shell (sh on macOS/Linux, cmd.exe on Windows): no `PORT=… cmd` prefixes; CEQU-Edit sets `PORT` itself. It runs in the project folder for the live app, and in a copy for previews. `{port}` is replaced and `PORT` is set too. It runs through `/bin/sh`, so `cd web && npm run dev -- --port {port}` works. **Pick a command that reloads when files change.** |
| `build` | The production build. It runs in a clean copy, never in the project folder. |
| `out` | The folder the build leaves the final site in, relative to the project. Omit it for server apps whose build is not a folder of files. |
| `start` | Server apps only (no `out`): the production server with `{port}`. Used only for the Built view. |
| `url` | Only when the app is already running and CEQU-Edit must not start it (e.g. docker compose). Then the preview shows code changes only. |

How to choose:
1. Read `package.json` scripts (or `manage.py`, `Gemfile`, `composer.json`, `pyproject.toml`, `go.mod`).
2. Pick the script that serves the UI with live reload, and make sure the port can be set.
3. For a Python venv, call its interpreter directly (`.venv/bin/python manage.py …`; on Windows `.venv\Scripts\python manage.py …`). CEQU-Edit copies `.venv` into the preview copy, so the same path works there.
4. Check the commands once by running them yourself, or start CEQU-Edit and read `~/.cequ-edit/sites/<site>/logs/app-live.log`.

## Common stacks

| Stack | `command` | `build` / `out` (or `start`) |
|---|---|---|
| Vite (React, Vue, Svelte, Solid, Preact, Lit) | `npm run dev -- --port {port} --strictPort` | `npm run build` / `dist` |
| Next.js | `npm run dev -- -p {port}` | `npm run build` / `start: npm start -- -p {port}`; static export: `out` |
| Create React App | `npm start` (uses `PORT`) | `npm run build` / `build` |
| Nuxt | `npm run dev -- --port {port}` | `npm run generate` / `.output/public`, or `npm run build` / `start: node .output/server/index.mjs` |
| SvelteKit | `npm run dev -- --port {port} --strictPort` | `npm run build` / `build` (adapter-static) or `start: node build` |
| Astro | `npm run dev -- --port {port}` | `npm run build` / `dist` |
| Remix / React Router 7 | `npm run dev -- --port {port}` | `npm run build` / `start: npm start` |
| Angular | `npx ng serve --port {port}` | `npx ng build` / `dist/<project>/browser` |
| Gatsby | `npm run develop -- -p {port}` | `npm run build` / `public` |
| Vue CLI | `npm run serve -- --port {port}` | `npm run build` / `dist` |
| Express / Koa / Fastify / Hono | `node --watch server.js` or `npx nodemon server.js` (the app must listen on `process.env.PORT`) | no build: omit `build`, or `start: node server.js` |
| Django | `.venv/bin/python manage.py runserver 127.0.0.1:{port}` | none |
| Flask | `python3 -m flask --app app run --debug --port {port}` | none |
| FastAPI | `.venv/bin/uvicorn main:app --reload --port {port}` | none |
| Rails | `bin/rails server -p {port}` | none |
| Laravel | `php artisan serve --port={port}` | `npm run build` / `public/build` (assets only) |
| Plain PHP | `php -S 127.0.0.1:{port}` (add `-t public` if the site root is `public/`) | none |
| Hugo | `hugo server --port {port} --bind 127.0.0.1` | `hugo` / `public` |
| Jekyll | `bundle exec jekyll serve --port {port}` | `bundle exec jekyll build` / `_site` |
| Eleventy | `npx @11ty/eleventy --serve --port={port}` | `npx @11ty/eleventy` / `_site` |
| Go | `go run .` (the app must read `PORT`) | `start: go run .` |
| .NET | `dotnet watch run --urls http://127.0.0.1:{port}` | none |

## Things to tell the owner at setup

- **Git:** if the project is not a git repository yet, CEQU-Edit makes one: a "Baseline" commit, plus standard `.gitignore` lines for `node_modules`, `.env`, build output and so on. If it already is one, each approved batch becomes a commit on the current branch, and their unsaved work is committed as "Manual edits" first. CEQU-Edit refuses a folder inside another repository: point it at the repository's top folder and use `cd sub && …` in `command`.
- **Two copies run while previewing:** the live app and a private preview copy. A large app uses about twice the memory during a preview.
- **The preview runs one command.** A frontend that calls a separate backend on a fixed port talks to the live backend in the preview: backend changes show after Approve.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Your app isn't running" page | Read the log shown there. Common causes: the port flag is wrong for this tool, a missing `.env`, or the app ignores `PORT`. Fix `command`, then press **Restart**. |
| Preview bar says the preview copy could not start | Often a fixed port hard-coded in the app (make it read `PORT`) or a docker setup. Code changes, Approve and Undo still work. |
| API calls fail only inside CEQU-Edit | The backend allows only certain origins (CORS). Add `http://localhost:8125` to the allowed origins, or proxy `/api` through the dev server (Vite `server.proxy`, Next rewrites). |
| Clicking shows "🔎 Claude will look for it" a lot | Normal for markup with no text or classes. Select a parent or child (↑ / ↓) with more to go on, or describe the change; Claude finds it. |
| Build fails | Use **Fix with Claude** in the build box, or read `~/.cequ-edit/sites/<site>/logs/build.log`. |
