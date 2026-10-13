# Decision notes

State of 13 Oct 2026. Everything needed to run, change and extend the tool is in this folder.

## What it is for

Taking notes into HTML decision docs during a meeting, with four requirements:

1. **Write in place, quickly.** Notes sit next to the heading or table row they are about. No dialog, no copy-paste.
2. **Persist.** Nothing typed is lost, even if the browser tab or the server dies.
3. **Live Markdown.** Notes land as Markdown next to the doc while typing, so they are in the vault (and in git) without an export step.
4. **Reusable.** Works on any HTML doc in the folder without changing the doc.

## Decisions taken, and why

| Decision | Chosen | Rejected, and why |
| --- | --- | --- |
| How notes reach the disk | Small local Node server | Browser extension: an extension cannot write into an arbitrary folder such as the vault without extra parts (File System Access handles, an offscreen document or a native host), and it needs installing per browser. File System Access API from the page: Chrome and Edge only, a permission click per session, and every doc would need a script tag. |
| How the layer gets into a doc | Injected by the server while serving | A `<script>` tag in each doc: breaks requirement 4. |
| Source of truth | `<doc>.notes.md`, browser storage as backup | JSON sidecar plus Markdown: two files to keep in sync. The Markdown carries `<!-- note:id -->` markers so it can be read back. |
| How a note finds its place | The text of its heading or row | DOM position: breaks as soon as anything is inserted above. Text survives edits elsewhere; if the text itself changes, the note is kept in an "orphans" box. |
| Dependencies | None at runtime; jsdom for tests | |

## Existing tools checked (13 Oct 2026)

None met all four requirements. The closest:

- **Obsidian Annotator**: Markdown in the vault, but built for PDF and EPUB; web pages only "in theory", local HTML unclear, slow maintenance.
- **AnyAnnotate**: Chrome extension, appends to a connected Markdown file, works on `file://`. One file for all clips rather than notes per doc and section; very young.
- **web-annotator**: local Chrome extension, manual export only.
- **Obsidian comment plugins** (Document Comments, Annoteca, Side Comments, Siden): Markdown notes only, not HTML.
- **Cloud annotation and feedback services** (Hypothesis, Marker.io, Pastel): store data outside EnBW; ruled out for internal docs.

## How it works

```
browser  --GET /doc.html-->            serve.mjs reads doc.html, adds <script src="/__notes/client.js">
browser  --GET /__notes/data?doc=-->   serve.mjs parses doc.notes.md -> JSON
browser  --PUT /__notes/data?doc=-->   serve.mjs renders JSON -> doc.notes.md (tmp file + rename)
```

### serve.mjs (Node 18+, no dependencies)

- `resolveDoc(root, name)`: accepts only `.html` files inside the root, decodes the name first so encoded `../` is caught.
- `renderNotes` / `parseNotes`: the Markdown format below. Empty notes are not written.
- `injectClient`: adds the script tag before `</body>`; the file on disk is never touched.
- `GET /` lists all `.html` files under the root (dot folders and `node_modules` skipped).
- Notes are only read and written for docs that exist. Note IDs must be slugs (`a-z`, `0-9`, `-`).
- Listens on 127.0.0.1 only and answers only requests whose `Host` is `localhost` or `127.0.0.1` (blocks DNS rebinding from web pages). Default port 4321 (`PORT` to change); the root is the first argument, default the current folder; the server refuses to start if it does not exist.

### client.js (plain browser script, runs on the injected tag)

- Anchors: every `h1`, `h2`, `h3` and `tbody tr` with text. ID = slug of the text (row text = cells joined with ` | `), with the next free `-2`, `-3` for repeats.
- Hover shows an orange **+** at the anchor; click it or press **N**. N acts on the anchor under the pointer; off the anchors the + hides and N does nothing. N is ignored while typing in a field.
- Each keystroke: browser backup at once (`localStorage`, key `decision-notes:<doc path>`: all notes, flag `dirty`, and the IDs `edited` since the last save), save to the server after 400 ms.
- A failed save turns the status pill red and retries every 5 s; the backup keeps the text.
- On load: notes edited in the browser and not yet saved win (and are pushed); for every other note the file wins, so hand edits to the Markdown show up.
- If the server is down at load, the backup is shown and nothing is saved until the file has been read once, so a restart cannot wipe the file with a partial set of notes. Load retries every 5 s.
- Notes whose anchor no longer exists go to a "Notes whose place is gone" box at the end of the page. They stay editable; clear one to delete it.

### Notes file format (`<doc>.notes.md`)

```markdown
# Notes: weekly-insights-decisions.html

_Last saved 2026-10-13 18:02_

## Where are shared reports stored?
<!-- note:where-are-shared-reports-stored -->

Backend ok, needs SiKon entry.
```

The `##` heading is the anchor's text at the time of writing, for humans. The `<!-- note:id -->` line is what the tool matches on. Text below can be edited freely, including Markdown headings of its own; keep the marker line intact. Text written by hand between the `_Last saved_` line and the first note (a summary, say) is kept on every save; the title and `_Last saved_` lines are rewritten.

## Run and test

```sh
npm install                       # only jsdom, for the tests
npm start -- ~/path/to/planning   # = node serve.mjs <root>, then open http://localhost:4321/
npm test                          # server helpers, the server on a random port, client in jsdom
```

## What is verified, and what is not

Verified by `npm test` (25 tests): path checks, Markdown round trip and hand edits, script injection, the server on a real port (serve doc, index skipping dot folders and `node_modules`, read and write notes, bad JSON, bad IDs, missing doc, traversal, foreign or malformed `Host`, too-large body, 20 overlapping saves leaving one whole file, index links for names with `#` or `?`, hand-written text above the first note kept on save, start through a symlinked path, refusing to start without the docs folder), loading notes into place, repeated headings, orphaned notes, adding a note to a table row with N, N ignored in fields, browser backup, debounced save, red status and retry when the server is down, unsaved edits winning on load, keystrokes during a load kept, untouched backup copies not undoing hand edits, IDs of headings ending in a number, no save before the file was read, stale boxes removed after a late load, empty orphans box removed, + hidden and N inert once the pointer leaves the anchors.

Verified once by hand on 13 Oct 2026 in headless Chromium against the real server (script not kept in the repo): index page, + position next to a heading, pointer moved step by step from the heading onto the + without it vanishing, + hidden and N inert over a paragraph, + click, N on a table row, Markdown written, notes back after reload, red status with the server killed, text typed while down reaching the file after restart.

Not verified: Safari and Firefox, a real (headed) browser with a mouse, and Node 18/20 (tests ran on Node 22; jsdom 26 is pinned because later versions need Node 22+).

## Known limits

- **One writer per doc.** Two browsers on the same doc overwrite each other's notes (last save wins). Fine for one note taker per meeting.
- **Anchors are only headings and table rows.** A paragraph or list item cannot get its own note yet.
- **Short or repeated headings** ("Was gut lief" in two places) are told apart by order only; if one is deleted, the other's notes can shift to it.
- **The server must run.** Opened via `file://`, a doc has no note layer.
- **Only HTML is served.** Images or stylesheets that a doc links as separate files do not load; self-contained docs work.
- **No authentication.** Anything on the machine can call localhost:4321; it can only read and write HTML and notes files inside the folder.

## Ideas, in rough order of value

1. Start the server at login (a launchd agent on macOS), so there is nothing to remember before a meeting.
2. A status per decision (open, agreed, rejected) next to the note, written into the Markdown heading.
3. Notes on paragraphs and list items, not only headings and rows.
4. A "summary" view: all notes of a doc in one panel, for reading out the decisions at the end of a meeting.
5. Two people at once: merge per note instead of overwriting the whole file.
6. If the team wants no server: rebuild as a Chrome extension with File System Access, keeping the same Markdown format so existing notes stay valid.
