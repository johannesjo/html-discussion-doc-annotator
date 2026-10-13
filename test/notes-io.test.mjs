import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNotes, saveNotes, serial, usableFolder } from '../extension/notes-io.js';
import { parseNotes } from '../extension/format.js';

// In-memory stand-in for a FileSystemDirectoryHandle: just the calls notes-io makes.
function fakeFolder(files = {}, permission = 'granted') {
  const store = new Map(Object.entries(files));
  const fileHandle = (name) => ({
    getFile: async () => ({ text: async () => store.get(name) }),
    createWritable: async () => {
      let buffer = '';
      return {
        write: async (text) => (buffer += text),
        close: async () => store.set(name, buffer),
        abort: async () => undefined,
      };
    },
  });
  return {
    name: 'meetings',
    store,
    queryPermission: async () => permission,
    getFileHandle: async (name, { create } = {}) => {
      if (!store.has(name) && !create) throw new DOMException('not found', 'NotFoundError');
      if (!store.has(name)) store.set(name, '');
      return fileHandle(name);
    },
  };
}

const PLAN = 'file:///home/me/planning/plan.html';
const note = (text) => ({ id: 'n-1', heading: 'Q', text, place: { at: 'h2:1', dx: 0, dy: 20 } });

test('save writes <doc>.notes.md into the folder, load reads it back', async () => {
  const dir = fakeFolder();
  assert.deepEqual(await loadNotes(dir, PLAN), []);
  assert.equal(await saveNotes(dir, PLAN, [note('Agreed.')]), 'plan.notes.md');
  assert.match(dir.store.get('plan.notes.md'), /^# Notes: plan.html\n<!-- doc: file:\/\/\/home\/me\/planning\/plan.html -->\n/);
  assert.deepEqual(await loadNotes(dir, PLAN + '#section'), [note('Agreed.')]);
});

test('save keeps text written by hand above the first note', async () => {
  const dir = fakeFolder();
  await saveNotes(dir, PLAN, [note('old')]);
  const edited = dir.store.get('plan.notes.md').replace('## Q', 'Summary: option B.\n\n## Q');
  dir.store.set('plan.notes.md', edited);
  await saveNotes(dir, PLAN, [note('new')]);
  assert.match(dir.store.get('plan.notes.md'), /_\n\nSummary: option B.\n\n## Q\n<!-- note:n-1 [^\n]+ -->\n\nnew\n$/);
});

test('a same-named doc from another folder gets its own file; neither overwrites the other', async () => {
  const dir = fakeFolder();
  const other = 'file:///home/me/archive/plan.html';
  await saveNotes(dir, PLAN, [note('mine')]);
  const otherName = await saveNotes(dir, other, [note('other doc')]);
  assert.match(otherName, /^plan\.[0-9a-f]{8}\.notes\.md$/);
  assert.equal((await loadNotes(dir, PLAN))[0].text, 'mine');
  assert.equal((await loadNotes(dir, other))[0].text, 'other doc');
  dir.store.delete('plan.notes.md'); // the other doc keeps finding its file after the first is gone
  assert.equal((await loadNotes(dir, other))[0].text, 'other doc');
});

test('a notes file without a doc line (old format, made by hand) is adopted', async () => {
  const dir = fakeFolder({ 'plan.notes.md': '# Notes: plan.html\n\n## Q\n<!-- note:q -->\n\nfrom the server days\n' });
  assert.deepEqual(await loadNotes(dir, PLAN), [{ id: 'q', heading: 'Q', text: 'from the server days', place: null }]);
});

test('bad notes are refused and the file is left alone', async () => {
  const dir = fakeFolder();
  await saveNotes(dir, PLAN, [note('keep')]);
  await assert.rejects(saveNotes(dir, PLAN, [{ id: 'x -->', heading: '', text: '' }]), { code: 'bad-notes' });
  assert.equal(parseNotes(dir.store.get('plan.notes.md'))[0].text, 'keep');
});

test('usableFolder: no folder, a changed folder and missing access each have their own code', async () => {
  await assert.rejects(usableFolder(null), { code: 'no-folder' });
  const record = { handle: fakeFolder(), version: 2 };
  await assert.rejects(usableFolder(record, 1), { code: 'folder-changed' });
  assert.equal(await usableFolder(record, 2), record.handle);
  assert.equal(await usableFolder(record), record.handle);
  await assert.rejects(usableFolder({ handle: fakeFolder({}, 'prompt'), version: 2 }), { code: 'no-access' });
});

test('serial runs saves one after another, and a failed one does not stop the next', async () => {
  const order = [];
  const slow = serial(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('slow');
  });
  const failing = serial(async () => {
    order.push('failing');
    throw new Error('disk full');
  });
  const last = serial(async () => order.push('last'));
  await slow;
  await assert.rejects(failing, /disk full/);
  await last;
  assert.deepEqual(order, ['slow', 'failing', 'last']);
});
