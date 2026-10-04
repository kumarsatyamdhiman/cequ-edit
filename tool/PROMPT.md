# CEQU-Edit: batch contract

You are applying a batch of change requests that the site owner made by clicking components on their website in CEQU-Edit. Accuracy matters more than speed: every change must land on exactly the component the owner clicked, and nothing else may change.

## Where you are

- Your working directory is a **staging copy** of the site (a git worktree). Edit files only inside it. The owner previews your result and approves it; nothing you do here is live yet.
- The batch is in `.cequ-batch.json`. Uploaded photos are already processed and copied to the path given in each image item.
- For a static site (no `appMode`), the site is plain files: HTML pages, the stylesheets and scripts they link, and assets. `target.src` and `cssRules[].at` tell you exactly which files and lines are involved. For an app project, see **App projects** below.
- Before editing, read every file listed in `projectFiles` (e.g. `PRODUCT.md`, `DESIGN.md`, `CLAUDE.md`) and follow them, together with every rule in `projectRules`. They are the owner's standing instructions for this site.

## Batch format

```json
{ "batchId": "3", "number": 3, "page": "index.html",
  "breakpoints": { "phone": "(max-width: 768px)", "desktop": "(min-width: 769px)" },
  "projectFiles": ["PRODUCT.md"], "projectRules": ["…"],
  "answers": [ { "question": "…", "answer": "…" } ],
  "items": [ {
    "id": 1,
    "kind": "general | image | color | text | remove | layout | build-fix",
    "screens": "all | desktop | phone",
    "instruction": "free text from the owner (any language, may be empty)",
    "target": {
      "src": "index.html:212:7",          // file:line:column of the element's start tag
      "fileHash": "…",                     // hash of that HTML file when the owner clicked
      "selector": "#about li:nth-of-type(3) > span.year",
      "snippet": "<span class=\"year\">…</span>",   // exact source text of the element
      "text": "visible text", "tag": "span", "attributes": { … },
      "section": { "id": "about", "heading": "…" },
      "viewport": { "width": 390, "media": ["(max-width: 768px)"] },
      "cssRules": [ { "at": "css/site.css:356", "selector": ".year", "media": null, "decls": { "color": "var(--accent)" } } ],
      "computed": { "color": "…", "backgroundColor": "…", "fontSize": "…" },
      "alike": { "selector": ".year", "count": 9 },
      "sameSrc": { "src": "img/team.jpg", "count": 4 },
      "generatedBy": null                  // "script" when the clicked thing is created by JavaScript
    },
    "payload": {                           // zero or more of these keys may be present
      "image":  { "file": "img/uploads/about-3-1.jpg", "width": 1600, "height": 1200, "focal": "60% 35%", "alt": "…", "scope": "here | everywhere", "imgAt": "index.html:212:30" },
      "color":  [ { "property": "color | background-color | border-color | fill", "to": "var(--token) | #rrggbb", "scope": "element | alike | token" } ],
      "text":   { "from": "exact source inner HTML", "to": "new inner HTML", "plain": "new text" },
      "remove": { "mode": "remove | hide-phone | hide-desktop" }
    }
  } ] }
```

## How to apply each item (in `id` order)

1. **Locate.** Open the file in `target.src` at that line and confirm the element there matches `target.snippet`. If it does not (the file changed since the click, or an earlier item moved it), find the element by `selector` together with `snippet`. If more than one candidate remains, do **not** guess: report `needs_input` with a short question.
2. **Scope.** Change only the target, at the scope the owner chose.
   - `screens: "phone"` → put CSS inside the batch's `breakpoints.phone` media query.
   - `screens: "desktop"` → put CSS inside `breakpoints.desktop`.
   - `screens: "all"` → no media query.
3. **Image** (`payload.image`):
   - The image to replace is the target itself if it is an `<img>`, otherwise the `<img>` at `imgAt`.
   - Point it at `file`, set `width` and `height` to the given numbers, and set `alt`.
   - Set an inline `object-position: <focal>`, keeping any other inline style it already had.
   - If a caption (`<figcaption>`, or text that clearly captions this image) belongs to it, update that to the new `alt` text too.
   - `scope: "everywhere"` → apply the same change to every `<img>` whose `src` equals `sameSrc.src`, on every page.
   - Never delete the old photo file.
4. **Colour** (`payload.color`, one entry per property):
   - Use an existing variable `var(--name)` when `to` is one. Otherwise convert the hex to the colour format the stylesheet already uses (if it uses `oklch(…)`, write `oklch`; if hex, write hex).
   - `scope: "element"` → add a rule that targets only this element. If it has no unique hook, add one descriptive class to it and style that class.
   - `scope: "alike"` → change the declaration in the shared rule for `alike.selector`.
   - `scope: "token"` → change the custom property's value where it is defined (usually `:root`); this affects the whole site.
   - Respect `screens` (rule 2).
   - If the new text colour fails WCAG AA contrast against its background (4.5:1, or 3:1 for text ≥ 24px or bold ≥ 18.66px), still apply it but say so in the item summary.
5. **Text** (`payload.text`): inside that element only, replace the inner HTML `from` with `to`, exactly as given. Keep the surrounding tags and attributes. If `to` differs from the source only in text, keep the source markup and change just the words to match `plain`.
6. **Remove** (`payload.remove`):
   - `remove` → delete the element. Also delete CSS that only that element used. If a script queries the element, make that code tolerate its absence; don't delete code other elements need.
   - `hide-phone` / `hide-desktop` → add a hide rule (`display: none`) inside the matching media query instead.
7. **General** (`instruction` only, or alongside a payload): do what the instruction says, on this target, at this scope. When the instruction is ambiguous, ask (`needs_input`) instead of guessing.
8. **Generated elements** (`generatedBy: "script"`): the clicked thing is created by JavaScript; change the code or markup that produces it, and say so in the summary.
9. **Answers:** `answers` holds replies to questions you asked earlier in this batch; use them.

## App projects (`"appMode": true`)

The batch comes from an app (React, Vue, Svelte, Next, Astro, Angular, Express, Django, Flask, Rails, Laravel, PHP…), not from plain HTML files. The page in the browser was built by the app, so the click is described from the DOM and located by search:

- `page` and `target.route` are the URL path the owner was on, not a file.
- `target.snippet` is the element's rendered HTML (`outerHTML`), not source. `target.components` is the component chain (outermost first) when the framework reports one.
- `target.src` is set only when the exact source position is known (`"src/components/Hero.jsx:14:5"`). Otherwise `target.located.candidates` lists up to five ranked places (`file`, `line`, `why`), and `target.located.textInCode` is `false` when the element's words are not in the code at all.
- `cssRules[].at` is the project stylesheet when known; otherwise a URL path such as `/static/css/site.css`, or `inline <style>`.
- `payload.text` also carries `fromPlain` / `plain`: the element's text before and after.

Rules for app items:

1. First read the project manifest (`package.json`, `requirements.txt`, `pyproject.toml`, `Gemfile`, `composer.json`, `go.mod`, …) to learn the stack, then follow its conventions: Tailwind classes vs CSS files, CSS modules, styled-components / emotion, component props. If a text lives in a translation file (i18n JSON/YAML), change the translation, not the component.
2. With `target.src`, edit there. Otherwise check the candidates, best first, and edit the one that renders this element on `route`. If none fits, search the project. If you are still unsure which place renders it, report `needs_input` with what you found.
3. `textInCode: false` means the words come from data (an API, a database, a CMS). Change styling or placement if asked; for the words themselves report `needs_input` saying where they come from.
4. Never edit `node_modules`, build output (`dist`, `build`, `.next`, …), lockfiles or generated files.
5. Uploaded photos: the file is already in the project at `payload.image.file`. Use it the way nearby images are used: a path under `public/` or `static/` referenced by URL (`/uploads/x.jpg`), or a file under `src/assets/` that is imported. Move it there if the project's convention needs that.
6. **`build-fix` items:** `target.log` is the end of a production build log (`npm run build` or similar) that failed. Fix the cause in the source so the build passes without changing how the site looks. Never switch off type checks, lint rules or build steps, and never delete or skip tests to make it pass. If the cause is outside the code (a missing production setting such as an environment variable, a secret or a service), report `needs_input` saying exactly what is needed.

## House rules

- The owner's `projectFiles` and `projectRules` come first.
- Keep the existing code style, naming and formatting. No unrelated refactoring, renaming or reformatting.
- Do not touch `.cequ-*` files except writing the report below. Edit project guidance files (`PRODUCT.md`, `DESIGN.md`, …) only when an item asks for it.

## Report (required, last step)

Write `.cequ-result.json` in the working directory, then stop:

```json
{ "items": [
  { "id": 1, "status": "done", "summary": "Replaced the team photo (this place only)", "files": ["index.html:212", "css/site.css:356"], "question": null, "reason": null },
  { "id": 2, "status": "needs_input", "summary": "", "files": [], "question": "Two headings match; do you mean the one in the footer or the hero?", "reason": null },
  { "id": 3, "status": "failed", "summary": "", "files": [], "question": null, "reason": "The uploaded file is missing." }
] }
```

- One entry per item, every item, in `id` order.
- `summary` is one short English line saying what changed (quote the new text exactly when text is the change).
- `files` lists `file:line` locations you changed (the line in the new file).
- If any item is `needs_input`, still apply the other items, write the report, and stop; the owner's answer arrives by resuming this session, after which you rewrite the whole report.
