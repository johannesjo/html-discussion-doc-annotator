// Keeping notes safe: every change goes to a browser backup at once and, shortly after, to the
// notes file through the background worker. Nothing is saved before the file was read once.
'use strict';

const dn = {
  cfg: Object.assign({ saveDelay: 400, retryDelay: 5000 }, window.DECISION_NOTES_CONFIG),
  url: location.href.split('#')[0], // the address the notes were loaded for
  backupKey: 'decision-notes:' + location.href.split('#')[0],
  notes: new Map(), // id -> { heading, text, place }
  active: false, // the layer shows only on pages with notes, or once the side panel starts a session here
  loaded: false, // no save before the file was read once, or we would overwrite it
  version: undefined, // the folder the notes came from; the worker refuses saves into another one
  folder: '',
  status: { kind: 'loading', text: 'Loading notes…' },
  saving: false,
  again: false,
  edits: 0,
  saved: 0, // successful saves; a load answered across one may be stale
  edited: new Set(), // ids changed since the last successful save
  timer: null,
  retry: null,
};

const PROBLEMS = {
  'no-folder': 'No notes folder yet. Click the Decision notes icon to choose one.',
  'no-access': 'Chrome needs your OK for the notes folder. Click the Decision notes icon.',
  'name-taken': 'Two other docs with this name already have notes in this folder. Choose another folder.',
};

async function ask(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (reply && reply.ok) return reply;
  const err = new Error(reply ? reply.message : 'No answer from the extension');
  err.code = reply ? reply.error : 'failed';
  throw err;
}

/** Change a note (text, place) and save it: backup now, file after a short pause. */
function updateNote(id, patch) {
  dn.notes.set(id, { ...dn.notes.get(id), ...patch });
  dn.edits++;
  dn.edited.add(id);
  writeBackup();
  scheduleSave(dn.cfg.saveDelay);
}

function noteList() {
  return Array.from(dn.notes, ([id, n]) => ({ id, heading: n.heading, text: n.text, place: n.place ?? null }));
}

// All notes are kept (shown if the folder cannot be read at load); only `edited` ones override the file.
function writeBackup() {
  const edited = Array.from(dn.edited);
  const backup = { dirty: edited.length > 0, edited, notes: noteList() };
  chrome.storage.local
    .set({ [dn.backupKey]: backup })
    .catch((err) => console.warn('Decision notes: browser backup failed', err));
}

async function readBackup() {
  try {
    return (await chrome.storage.local.get(dn.backupKey))[dn.backupKey] ?? null;
  } catch (err) {
    console.warn('Decision notes: unreadable browser backup', err);
    return null;
  }
}

function setStatus(kind, text) {
  dn.status = { kind, text };
  renderStatus();
}

function scheduleSave(delay) {
  clearTimeout(dn.timer);
  dn.timer = setTimeout(save, delay);
}

async function save() {
  if (!dn.loaded) return; // load() pushes the backup once the file was read
  if (location.href.split('#')[0] !== dn.url) return addressChanged();
  if (dn.saving) {
    dn.again = true;
    return;
  }
  dn.saving = true;
  const edits = dn.edits;
  setStatus('saving', 'Saving…');
  try {
    const reply = await ask({ type: 'save', notes: sortedNotes(), version: dn.version });
    dn.saved++;
    if (edits === dn.edits) {
      dn.edited.clear();
      writeBackup();
    }
    setStatus('ok', `Saved ${clock()} to ${dn.folder}/${reply.file}`);
  } catch (err) {
    saveFailed(err);
  } finally {
    dn.saving = false;
    if (dn.again) {
      dn.again = false;
      scheduleSave(0);
    }
  }
}

// The worker names the file after the tab's current address: saving now would put these notes
// into the file of a page (in a single-page app) whose own notes were never loaded.
function addressChanged() {
  setStatus('error', 'The page address changed. Reload to take notes here; text typed since is saved when you open the previous address again.');
}

function saveFailed(err) {
  console.warn('Decision notes: save failed', err);
  if (err.code === 'folder-changed') {
    // another folder was picked: read its file first, then the unsaved notes go on top
    dn.loaded = false;
    load();
    return;
  }
  setStatus('error', PROBLEMS[err.code] ?? 'Not saved, retrying. Text is kept in this browser.');
  scheduleSave(dn.cfg.retryDelay);
}

// Document order in the file: top to bottom as the cards sit on the page, lost notes last.
function sortedNotes() {
  const spot = new Map(Array.from(dn.notes, ([id, note]) => [id, notePosition(note)]));
  return noteList().sort((a, b) => spot.get(a.id).y - spot.get(b.id).y || spot.get(a.id).x - spot.get(b.id).x);
}

// Notes typed in but not yet saved, per the backup. Marks them edited again, so the next
// backup and save keep treating them as unsaved.
function unsavedNotes(backup) {
  if (!backup || !backup.dirty || !Array.isArray(backup.notes) || !Array.isArray(backup.edited)) return [];
  const unsaved = backup.notes.filter((n) => backup.edited.includes(n.id));
  unsaved.forEach((n) => dn.edited.add(n.id));
  return unsaved;
}

function applyNotes(list) {
  dn.notes = new Map(list.map((n) => [n.id, { heading: n.heading, text: n.text, place: n.place ?? null }]));
  if (dn.active) renderCards();
}

// Notes edited in the browser and not yet saved win over the file; otherwise the file wins.
async function load() {
  clearTimeout(dn.retry);
  try {
    const saved = dn.saved;
    const reply = await ask({ type: 'load' });
    if (dn.saved !== saved) return load(); // the file was read before a save that finished meanwhile
    // read the backup only now, so keystrokes typed while the request was in flight are in it
    const unsaved = unsavedNotes(await readBackup());
    Object.assign(dn, { version: reply.version, folder: reply.folder, loaded: true });
    applyNotes(reply.notes.concat(unsaved));
    if (dn.notes.size) activate();
    if (unsaved.length) save();
    else setStatus('ok', `Notes folder: ${reply.folder}`);
  } catch (err) {
    await loadFailed(err);
  }
}

async function loadFailed(err) {
  console.warn('Decision notes: load failed', err);
  const backup = await readBackup();
  if (!dn.notes.size && backup && Array.isArray(backup.notes) && backup.notes.length) {
    applyNotes(backup.notes);
    unsavedNotes(backup);
    activate();
  }
  setStatus('error', PROBLEMS[err.code] ?? 'Notes not loaded, retrying. Text is kept in this browser.');
  // a page without notes stays quiet; the side panel wakes it when a session starts here
  if (dn.active) dn.retry = setTimeout(load, dn.cfg.retryDelay);
}

function clock() {
  return new Date().toTimeString().slice(0, 5);
}
