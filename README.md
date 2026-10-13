# Decision notes

State of 13 Oct 2026. A Chrome extension; everything needed to load, change and extend it is in this folder.

## What it is for

Taking notes into HTML decision docs during a meeting, with four requirements:

1. **Write in place, quickly.** A note sits on the spot it is about: a heading, a paragraph, a table cell, or bare space on the page. No dialog, no copy-paste.
2. **Persist.** Nothing typed is lost, even if the tab closes or the folder cannot be written for a moment.
3. **Live Markdown.** Notes land as Markdown while typing, one file per doc, in a folder chosen per session (the vault, say), so they are in the vault (and in git) without an export step.
4. **Reusable.** Works on any page, including local `file://` docs, without changing the doc.

## Decisions taken, and why

| Decision | Chosen | Rejected, and why |
| --- | --- | --- |
| How notes reach the disk | Chrome extension (Manifest V3) with the File System Access API: a folder picked in the side panel, written by the service worker | The first version, a local Node server that injected the layer while serving docs (commit `33f52e3`): a server to start before every meeting, no `file://` docs, no images or stylesheets beside the doc, no note on paragraphs or free space. A native messaging host: an extra install step for nothing the folder handle cannot do. Chrome only is accepted. |
| Where the notes file goes | One file per doc in the folder picked for the session; picking the same folder again continues it, another folder starts empty | Next to the doc: impossible for web pages, and docs and notes often belong in different places. |
| Source of truth | `<doc>.notes.md`, `chrome.storage.local` as backup | JSON sidecar plus Markdown: two files to keep in sync. The marker line of each note carries its place as JSON, so the file can be read back. |
| How a note finds its place | Path of tag positions (`table:1/tbody:1/tr:2/td:2`), checked against the element's text; if the text is not there, the nearest element of the same tag with that text | Text only: cannot tell "Was gut lief" in two places apart and cannot work for free spots. Path only: breaks as soon as something is inserted above. |
| Looks | Floating cards on the page, offset from their element and following it; collapsible | Inline boxes inside the doc: change the doc's layout, impossible inside tables. |
| Dependencies | None at runtime; jsdom for tests | |

## Existing tools checked (13 Oct 2026)

None met all four requirements. The closest:

- **Obsidian Annotator**: Markdown in the vault, but built for PDF and EPUB; web pages only "in theory", local HTML unclear, slow maintenance.
- **AnyAnnotate**: Chrome extension, appends to a connected Markdown file, works on `file://`. One file for all clips rather than notes per doc and section; very young.
- **web-annotator**: local Chrome extension, manual export only.
- **Obsidian comment plugins** (Document Comments, Annoteca, Side Comments, Siden): Markdown notes only, not HTML.
- **Cloud annotation and feedback services** (Hypothesis, Marker.io, Pastel): store data outside EnBW; ruled out for internal docs.

## Install (once)

1. `chrome://extensions` → switch on **Developer mode** → **Load unpacked** → pick the `extension/` folder.
2. In the extension's **Details**, switch on **Allow access to file URLs** (for docs opened from disk).
3. Pin the icon. Clicking it opens the side panel.

After changing the code: reload the extension on `chrome://extensions`, then reload open pages.

## Use

1. Open the doc, click the icon. In the side panel, **Choose folder…** (the system dialog; Chrome refuses the home folder itself and system folders; a folder inside your home folder is fine). Next time, **Continue in "name"** renews Chrome's permission with one click; Chrome 122+ may also offer to remember it.
2. While the panel is open, the page you look at has the note layer: **+ Note** and a status pill at the bottom right. A page that already has notes in the folder shows them without the panel.
3. Press **N** with the mouse over a spot, or click **+ Note** and then the spot. A note on a word goes to its paragraph; on bare space it stays at that page position.
4. Drag a card by its bar onto another element or onto bare space. The element under the pointer is outlined while dragging. **–** collapses a card to its first line, **×** deletes it (after a question). An empty new card disappears when you click elsewhere.

## How it works

```
side panel (panel.js)    showDirectoryPicker -> handle in IndexedDB (folder-store.js), sends "activate" to the shown tab
content scripts          cards on the page; every keystroke: backup in chrome.storage.local, save after 400 ms
  --"load"/"save"-->     service worker (background.js): notes-io.js reads and writes the file via the stored handle
```

- **`format.js`**: file name per doc, Markdown render and parse, validation of what pages send (IDs `a-z0-9-`, paths of `tag:n` steps, finite offsets).
- **`notes-io.js`**: finds the doc's file, keeps hand-written text above the first note, writes one save at a time (Chrome writes a swap file and swaps it in, so a crash never leaves half a file).
- **`content/locate.js`**: paths, labels, finding an element again, the block under the pointer (inline elements climb to their block; the page's `body` means bare space).
- **`content/store.js`**: notes state, backup, debounced save, retry every 5 s with a red status, load and merge.
- **`content/cards.js`**: cards, layout, tray for lost notes, drag and drop. **`content/main.js`**: toolbar, N key, relayout on resize and when the page's size changes.

Rules carried over from the server version: notes edited in the browser and not yet saved win on load (and are pushed); for every other note the file wins, so hand edits to the Markdown show up. Nothing is saved until the file has been read once, so a failed read cannot wipe it. If another folder is picked meanwhile, its file is read first and unsaved notes go there.

### File name

- `file:///…/plan.html` → `plan.notes.md`; if that name belongs to another doc (two `plan.html` in different folders), `plan.<hash>.notes.md`.
- Web pages: host and path, e.g. `wiki.example.com - team - plan.notes.md`.

### Notes file format

```markdown
# Notes: weekly-insights-decisions.html
<!-- doc: file:///home/me/planning/weekly-insights-decisions.html -->

_Last saved 2026-10-13 18:02_

## Where are shared reports stored?
<!-- note:n-3fa9c2d1 {"at":"main:1/h2:2","dx":12,"dy":-4} -->

Backend ok, needs SiKon entry.

## On the page
<!-- note:n-8b01e7aa {"dx":940,"dy":300,"min":true} -->

A note on bare space, collapsed.
```

The `##` heading is the element's text at the time of writing, for humans. The marker line is what the extension reads: `at` is the element's path, `dx`/`dy` the card's offset from it (or the page position without `at`), `min` a collapsed card. Text below can be edited freely, including Markdown headings of its own; keep the marker line intact. Text written by hand between the `_Last saved_` line and the first note is kept on every save; the title, doc and `_Last saved_` lines are rewritten. Files from the server version (`<!-- note:slug -->` without a place) load; their notes wait in the tray at the top right until dragged onto a spot.

## Test

```sh
npm install   # only jsdom
npm test      # format and file code against a fake folder, content scripts in jsdom against a fake worker
```

## What is verified, and what is not

Verified by `npm test` (42 tests): file names, Markdown round trip with hand edits and the old format, validation, a same-named doc from another folder getting its own file, hand-written text kept, saves one at a time, folder errors; in jsdom: quiet page until activated, N and + Note placing, note on a bold word going to its paragraph, debounced save and backup, N ignored in fields, red status and retry, unsaved edits winning on load, keystrokes during a load kept, no save before the file was read, a folder switch, cards at their offset and following their element, repeated headings, a moved heading found by its text, tray and drag back out of it, drag onto bare page and onto a cell, collapse, delete, empty card removed, a note near the right edge kept inside the window, a card dragged out of the tray following the pointer, focus kept in a tray card on relayout, elements with tags like `<w:sdt>` getting a free note, labels cut between characters not inside an emoji, a stale load read again, no save after the page changed its address, a clear message when the file name is taken, no extra lines from an encoded line break in the address.

Verified on 13 Oct 2026 in Chromium 149 (headless, extension loaded unpacked, doc over http, the extension's private storage standing in for the picked folder; script not kept in the repo; 18 checks, 5 of 5 runs passing): page quiet before the panel, session started, card at the pointer, N not typed into the note, Markdown written, drop target outlined, card dropped onto a table cell attached to it, card following its cell when content is inserted above, free note, collapsed card back in place after reload, card of a removed row in the tray, a card dragged out of the tray following the pointer and attached to the heading it is dropped on, another folder starting empty and getting new notes while the first stays untouched. This run found two bugs the jsdom tests missed (a drop landing on the card itself, margin notes widening the page); a code review found the tray drag and the other cases listed last above. All have tests now.

Not verified: the real folder dialog and permission prompts, permission after a browser restart, `file://` docs, a headed browser with a real mouse, Edge and other Chromium browsers, Node 18/20 for the tests.

## Known limits

- **One writer per doc.** Two tabs or browsers on the same doc and folder overwrite each other's notes (last save wins), and two tabs of one doc share one browser backup. Fine for one note taker per meeting.
- **Single-page apps.** If a page changes its address without reloading (some wikis do), saving stops with a red status until the page is reloaded; cards are not reloaded for the new address by themselves.
- **Cards follow layout changes, not scrolling inside boxes.** Elements in scrollable boxes or with `position: fixed`/`sticky` drift away from their cards.
- **A note's text must not contain a line like `<!-- note:x -->`**; reading the file back would split the note there.
- **Permission per browser session.** After a restart Chrome asks again (one click in the panel) unless it was told to remember the folder.
- **Only the folder's name is shown**, not its path; the File System Access API does not reveal paths.
- **The page's CSS can reach the cards.** They have their own styles, but a page with aggressive global rules can still change how they look.
- **Chrome pages, the Web Store and PDFs** cannot have notes; extensions are not allowed there.
- **Pages that change their content heavily** (apps rather than docs) can move notes into the tray when their element is gone.

## Ideas, in rough order of value

1. A status per decision (open, agreed, rejected) next to the note, written into the Markdown heading.
2. A "summary" view: all notes of a doc in the side panel, for reading out the decisions at the end of a meeting.
3. Two people at once: merge per note instead of overwriting the whole file.
4. Show the notes file name in the panel, with a link to open it.

(Dropped from the server version's list: starting the server at login, notes on paragraphs, and the extension rebuild itself; all three are done or obsolete.)
