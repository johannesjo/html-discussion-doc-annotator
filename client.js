// Decision notes: the in-page note layer. serve.mjs injects this as a plain script into every doc.
// Notes hang off headings and table rows by the slug of their text, not their DOM position.
(function () {
  'use strict';

  const cfg = Object.assign({ saveDelay: 400, retryDelay: 5000 }, window.DECISION_NOTES_CONFIG);
  const doc = location.pathname;
  const api = '/__notes/data?doc=' + encodeURIComponent(doc);
  const backupKey = 'decision-notes:' + doc;
  const ANCHORS = 'h1, h2, h3, tbody tr';
  const STYLE = `
.dn-add{position:fixed;z-index:2147483646;width:22px;height:22px;padding:0;border:0;border-radius:50%;
  background:#f28c28;color:#fff;font:bold 16px/22px sans-serif;cursor:pointer}
.dn-note{margin:.25em 0 1em}
.dn-text{box-sizing:border-box;width:100%;min-height:2.6em;padding:.4em .5em;border:1px solid #f28c28;
  border-left-width:4px;border-radius:3px;background:#fffaf3;color:#222;font:inherit;font-size:.95em;resize:vertical}
.dn-row>td{padding:.25em .5em}
.dn-status{position:fixed;right:12px;bottom:12px;z-index:2147483646;padding:3px 10px;border-radius:999px;
  background:#e8e8e8;color:#333;font:12px sans-serif}
.dn-status[data-state=error]{background:#d33;color:#fff}
.dn-orphans{margin:2em 0;padding:0 1em 1em;border:2px dashed #f28c28}
.dn-orphan-heading{margin:.8em 0 .2em;font-weight:bold}`;

  const state = {
    anchors: new Map(), // id -> { el, heading }, in document order
    idOf: new Map(), // anchor element -> id
    notes: new Map(), // id -> { heading, text }
    boxes: new Map(), // id -> textarea
    hovered: null,
    loaded: false, // no save before the file was read once, or we would overwrite it
    saving: false,
    again: false,
    edits: 0,
    edited: new Set(), // ids typed in since the last successful save
    timer: null,
    status: null,
  };

  function slug(text) {
    const s = text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 80)
      .replace(/^-+|-+$/g, '');
    return s || 'note';
  }

  function anchorText(el) {
    const clean = (s) => s.replace(/\s+/g, ' ').trim();
    if (el.tagName !== 'TR') return clean(el.textContent);
    return Array.from(el.cells, (cell) => clean(cell.textContent)).filter(Boolean).join(' | ');
  }

  function collectAnchors() {
    document.querySelectorAll(ANCHORS).forEach((el) => {
      const heading = el.closest('.dn-ui') ? '' : anchorText(el);
      if (!heading) return;
      const base = slug(heading);
      // next free suffix, so "Option", "Option 2", "Option" cannot share option-2
      let id = base;
      for (let n = 2; state.anchors.has(id); n++) id = base + '-' + n;
      state.anchors.set(id, { el, heading });
      state.idOf.set(el, id);
    });
  }

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function makeArea(id) {
    const area = make('textarea', 'dn-text');
    area.placeholder = 'Note (Markdown)';
    area.rows = 2;
    area.addEventListener('input', () => onInput(id, area));
    area.addEventListener('blur', () => {
      if (!area.value.trim()) removeBox(id);
    });
    state.boxes.set(id, area);
    return area;
  }

  function removeBox(id) {
    const box = state.boxes.get(id).closest('.dn-box');
    if (box) box.remove();
    state.boxes.delete(id);
    const orphans = document.querySelector('.dn-orphans');
    if (orphans && !orphans.querySelector('.dn-box')) orphans.remove();
  }

  // A heading gets a box below it; a table row gets a full-width row below it.
  function ensureBox(id) {
    if (state.boxes.has(id)) return state.boxes.get(id);
    const anchor = state.anchors.get(id).el;
    const area = makeArea(id);
    let box;
    if (anchor.tagName === 'TR') {
      box = make('tr', 'dn-ui dn-box dn-row');
      const cell = make('td');
      cell.colSpan = Array.from(anchor.cells).reduce((sum, c) => sum + c.colSpan, 0);
      cell.append(area);
      box.append(cell);
    } else {
      box = make('div', 'dn-ui dn-box dn-note');
      box.append(area);
    }
    anchor.after(box);
    return area;
  }

  function renderOrphans() {
    const old = document.querySelector('.dn-orphans');
    if (old) old.remove();
    const ids = Array.from(state.notes.keys()).filter(
      (id) => !state.anchors.has(id) && state.notes.get(id).text.trim(),
    );
    if (!ids.length) return;
    const section = make('section', 'dn-ui dn-orphans');
    section.append(make('h2', '', 'Notes whose place is gone'));
    ids.forEach((id) => {
      const box = make('div', 'dn-box');
      const area = makeArea(id);
      area.value = state.notes.get(id).text;
      box.append(make('p', 'dn-orphan-heading', state.notes.get(id).heading || id), area);
      section.append(box);
    });
    document.body.append(section);
  }

  function applyNotes(list) {
    state.notes = new Map(list.map((n) => [n.id, { heading: n.heading, text: n.text }]));
    state.notes.forEach((note, id) => {
      if (!state.anchors.has(id) || !note.text.trim()) return;
      const area = ensureBox(id);
      if (area === document.activeElement) return; // never yank text out from under the typist
      area.value = note.text;
      grow(area);
    });
    // boxes shown from the backup while the server was down may be gone from the file
    state.boxes.forEach((area, id) => {
      const note = state.notes.get(id);
      if ((!note || !note.text.trim()) && area !== document.activeElement) removeBox(id);
    });
    renderOrphans();
  }

  // Document order first, then notes whose anchor is gone.
  function noteList() {
    const ids = Array.from(state.anchors.keys()).filter((id) => state.notes.has(id));
    state.notes.forEach((_, id) => {
      if (!state.anchors.has(id)) ids.push(id);
    });
    return ids.map((id) => ({ id, heading: state.notes.get(id).heading, text: state.notes.get(id).text }));
  }

  function readBackup() {
    try {
      return JSON.parse(localStorage.getItem(backupKey) || 'null');
    } catch (err) {
      console.warn('Decision notes: unreadable browser backup', err);
      return null;
    }
  }

  // All notes are kept (shown if the server is down at load); only `edited` ones override the file.
  function writeBackup() {
    const edited = Array.from(state.edited);
    try {
      localStorage.setItem(backupKey, JSON.stringify({ dirty: edited.length > 0, edited, notes: noteList() }));
    } catch (err) {
      console.warn('Decision notes: browser backup failed', err);
    }
  }

  function setStatus(kind, text) {
    state.status.dataset.state = kind;
    state.status.textContent = text;
  }

  function clock() {
    return new Date().toTimeString().slice(0, 5);
  }

  function onInput(id, area) {
    const anchor = state.anchors.get(id);
    const heading = anchor ? anchor.heading : state.notes.get(id).heading;
    state.notes.set(id, { heading, text: area.value });
    state.edits++;
    state.edited.add(id);
    writeBackup();
    scheduleSave(cfg.saveDelay);
    grow(area);
  }

  function scheduleSave(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(save, delay);
  }

  async function save() {
    if (!state.loaded) return; // load() pushes the backup once the server answers
    if (state.saving) {
      state.again = true;
      return;
    }
    state.saving = true;
    const edits = state.edits;
    setStatus('saving', 'Saving…');
    try {
      const res = await fetch(api, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: noteList() }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (edits === state.edits) {
        state.edited.clear();
        writeBackup();
      }
      setStatus('ok', 'Saved ' + clock());
    } catch (err) {
      console.warn('Decision notes: save failed, retrying', err);
      setStatus('error', 'Not saved, retrying. Text is kept in this browser.');
      scheduleSave(cfg.retryDelay);
    } finally {
      state.saving = false;
      if (state.again) {
        state.again = false;
        scheduleSave(0);
      }
    }
  }

  // Notes typed in but not yet saved, per the backup. Marks them edited again, so the next
  // backup and save keep treating them as unsaved.
  function unsavedNotes(backup) {
    if (!backup || !backup.dirty || !Array.isArray(backup.notes) || !Array.isArray(backup.edited)) return [];
    const unsaved = backup.notes.filter((n) => backup.edited.includes(n.id));
    unsaved.forEach((n) => state.edited.add(n.id));
    return unsaved;
  }

  // Notes edited in the browser and not yet saved win over the file; otherwise the file wins.
  async function load() {
    try {
      const res = await fetch(api);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      // read the backup only now, so keystrokes typed while the request was in flight are in it
      const unsaved = unsavedNotes(readBackup());
      applyNotes((Array.isArray(data.notes) ? data.notes : []).concat(unsaved));
      state.loaded = true;
      if (unsaved.length) save();
      else setStatus('ok', 'Notes loaded');
    } catch (err) {
      console.warn('Decision notes: load failed, retrying', err);
      const backup = readBackup();
      if (!state.notes.size && backup && Array.isArray(backup.notes)) {
        applyNotes(backup.notes);
        unsavedNotes(backup);
      }
      setStatus('error', 'Server unreachable. Notes are kept in this browser.');
      setTimeout(load, cfg.retryDelay);
    }
  }

  function grow(area) {
    area.style.height = 'auto';
    area.style.height = area.scrollHeight + 2 + 'px';
  }

  function openNote(id) {
    if (!state.notes.has(id)) state.notes.set(id, { heading: state.anchors.get(id).heading, text: '' });
    const area = ensureBox(id);
    area.focus();
  }

  function isTyping(target) {
    return Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));
  }

  function setupInput() {
    const add = make('button', 'dn-ui dn-add', '+');
    add.type = 'button';
    add.title = 'Add note (N)';
    add.hidden = true;
    add.addEventListener('click', () => state.hovered && openNote(state.hovered));
    document.addEventListener('mouseover', (e) => {
      if (e.target === add) return;
      const el = e.target.closest && e.target.closest(ANCHORS);
      if (!el || !state.idOf.has(el)) {
        // pointer left the anchors: N and + must not act on one the user no longer sees
        state.hovered = null;
        add.hidden = true;
        return;
      }
      state.hovered = state.idOf.get(el);
      const rect = el.getBoundingClientRect();
      add.style.top = Math.max(0, rect.top + 2) + 'px';
      // overlap the anchor by 2px: a gap would hide the + on the way to it
      add.style.left = (rect.left >= 28 ? rect.left - 20 : rect.left + 2) + 'px';
      add.hidden = false;
    });
    window.addEventListener('scroll', () => (add.hidden = true), { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || !state.hovered) return;
      e.preventDefault();
      openNote(state.hovered);
    });
    document.body.append(add);
  }

  function init() {
    const style = make('style');
    style.textContent = STYLE;
    document.head.append(style);
    collectAnchors();
    state.status = make('div', 'dn-ui dn-status', 'Loading notes…');
    document.body.append(state.status);
    setupInput();
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
