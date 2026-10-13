// Reading and writing a doc's notes file in the chosen folder (a FileSystemDirectoryHandle).
// No chrome.* calls here, so the Node tests can run it against an in-memory folder.
import { docKey, notesFileName, parseDocUrl, parseNotes, parsePreamble, renderNotes, validNotes } from './format.js';

/** An error with a code that the page turns into a status message. */
export function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/**
 * The chosen folder's handle, if it can be used now. Throws no-folder, folder-changed (the page
 * loaded its notes from another folder) or no-access (Chrome wants the user's OK again).
 */
export async function usableFolder(record, version) {
  if (!record) throw coded('no-folder');
  if (version !== undefined && version !== record.version) throw coded('folder-changed');
  if ((await record.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') throw coded('no-access');
  return record.handle;
}

/** The notes of the doc at `url`, [] if it has no notes file in this folder yet. */
export async function loadNotes(dir, url) {
  return parseNotes((await findFile(dir, url)).text);
}

/** Write the doc's notes file, keeping hand-written text above the first note. Returns the file name. */
export async function saveNotes(dir, url, notes) {
  const clean = validNotes(notes);
  if (!clean) throw coded('bad-notes', 'Expected notes [{ id, heading, text, place }]');
  const file = await findFile(dir, url);
  const handle = file.handle ?? (await dir.getFileHandle(file.name, { create: true }));
  await writeText(handle, renderNotes(url, clean, { preamble: parsePreamble(file.text) }));
  return file.name;
}

let queue = Promise.resolve();

/** Run tasks one at a time, so a save never reads a file that another save is replacing. */
export function serial(task) {
  const run = queue.then(task);
  queue = run.catch(() => undefined); // the caller gets the error through `run`; the queue goes on
  return run;
}

// "plan.notes.md", unless that file belongs to another doc with the same name (two plan.html in
// different folders): then "plan.<hash>.notes.md". A file without a doc line is adopted.
async function findFile(dir, url) {
  const key = docKey(url);
  const base = notesFileName(url);
  const names = [base, base.replace(/\.notes\.md$/, `.${shortHash(key)}.notes.md`)];
  const files = await Promise.all(names.map((name) => readFile(dir, name)));
  const own = files.find((f) => f.handle && f.owner === key);
  const adopted = files[0].handle && !files[0].owner ? files[0] : null;
  const free = files.find((f) => !f.handle);
  const file = own ?? adopted ?? free;
  if (!file) throw coded('name-taken', `Other docs already use the notes files ${names.join(' and ')}`);
  return file;
}

async function readFile(dir, name) {
  try {
    const handle = await dir.getFileHandle(name);
    const text = await (await handle.getFile()).text();
    return { name, handle, text, owner: parseDocUrl(text) };
  } catch (err) {
    if (err.name === 'NotFoundError') return { name, handle: null, text: '', owner: null };
    throw err;
  }
}

// Chrome writes into a swap file and swaps it in on close, so a crash never leaves half a file.
async function writeText(handle, text) {
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (err) {
    await writable.abort().catch((abortErr) => console.warn('Decision notes: abort failed', abortErr));
    throw err;
  }
}

// FNV-1a: short and stable, only to tell same-named docs apart, not for security
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
