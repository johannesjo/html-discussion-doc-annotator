// Saving, backup and retry: carried over from the server version, now through the worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeExtension, openPage, until, wait, type, pressN, placeAt, status, cardsOf, textOf } from './content-harness.mjs';

const H1 = { at: 'h1:1', dx: 0, dy: 30 };
const ROW = { at: 'table:1/tbody:1/tr:1', dx: 0, dy: 20 };

test('a page without notes stays quiet until the side panel starts a session', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  await until(() => ext.loads === 1);
  await wait(20);
  assert.equal(window.document.querySelector('.dn-layer'), null);
  pressN(window, window.document.querySelector('h1'));
  assert.equal(cardsOf(window).length, 0, 'N is left to the page');
  ext.activate();
  await until(() => status(window).dataset.state === 'ok');
  assert.match(status(window).textContent, /meetings/);
});

test('N adds a note: backup at once, one debounced save, then clean', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await until(() => status(window).dataset.state === 'ok');
  pressN(window, window.document.querySelectorAll('tbody td')[2], 50, 60); // "Hiring"
  const [card] = cardsOf(window);
  const area = card.querySelector('textarea');
  assert.equal(window.document.activeElement, area);

  type(window, area, 'Ben');
  type(window, area, 'Ben starts in May');
  assert.equal(ext.backup().dirty, true);
  assert.equal(ext.backup().notes[0].text, 'Ben starts in May');
  assert.equal(ext.puts.length, 0); // debounced, not yet
  await until(() => ext.puts.length === 1);
  await wait(40);
  assert.equal(ext.puts.length, 1); // two keystrokes, one save
  const [saved] = ext.puts[0];
  assert.match(saved.id, /^n-[0-9a-f]{8}$/);
  assert.deepEqual(saved.place, { at: 'table:1/tbody:1/tr:2/td:1', dx: 50, dy: 60 });
  assert.equal(saved.heading, 'Hiring');
  assert.equal(ext.backup().dirty, false);
  assert.match(status(window).textContent, /^Saved \d\d:\d\d to meetings\/weekly.notes.md$/);
});

test('N is ignored while typing in a field', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await until(() => status(window).dataset.state === 'ok');
  const input = window.document.createElement('input');
  window.document.body.append(input);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  assert.equal(cardsOf(window).length, 0);
});

test('worker failing: status turns red, text stays in the backup, retry saves it later', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await until(() => status(window).dataset.state === 'ok');
  ext.down = true;
  ext.code = 'no-access';
  pressN(window, window.document.querySelector('h1'));
  type(window, cardsOf(window)[0].querySelector('textarea'), 'typed while down');
  await until(() => status(window).dataset.state === 'error');
  assert.match(status(window).textContent, /needs your OK.*icon/);
  assert.equal(ext.backup().dirty, true);
  ext.down = false;
  await until(() => ext.puts.length === 1);
  assert.equal(ext.puts[0][0].text, 'typed while down');
  await until(() => status(window).dataset.state === 'ok');
});

test('on load, unsaved browser edits win per note and are pushed; other file notes stay', async () => {
  const ext = fakeExtension([
    { id: 'n-a', heading: 'Weekly insights', text: 'file version', place: H1 },
    { id: 'n-b', heading: 'Budget | Anna', text: 'only in file', place: ROW },
  ]);
  const backup = { dirty: true, edited: ['n-a'], notes: [{ id: 'n-a', heading: 'Weekly insights', text: 'browser version', place: H1 }] };
  const window = openPage(ext, { backup });
  placeAt(window.document.querySelector('tbody tr'), 0, 400); // file order follows the page, top to bottom
  await until(() => ext.puts.length === 1);
  assert.deepEqual(cardsOf(window).map(textOf).sort(), ['browser version', 'only in file']);
  assert.deepEqual(ext.puts[0].map((n) => n.text), ['browser version', 'only in file']);
});

test('on load without unsaved edits the file wins, so hand edits show up', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Weekly insights', text: 'edited by hand', place: H1 }]);
  const backup = { dirty: false, edited: [], notes: [{ id: 'n-a', heading: 'Weekly insights', text: 'old', place: H1 }] };
  const window = openPage(ext, { backup });
  await until(() => status(window).dataset.state === 'ok');
  assert.deepEqual(cardsOf(window).map(textOf), ['edited by hand']);
  assert.equal(ext.puts.length, 0);
});

test('folder unreadable at load: shows the backup, never saves before the file was read', async () => {
  const ext = fakeExtension([{ id: 'n-b', heading: 'Budget | Anna', text: 'in file', place: ROW }]);
  ext.down = true;
  const backup = { dirty: true, edited: ['n-a'], notes: [{ id: 'n-a', heading: 'Weekly insights', text: 'unsaved', place: H1 }] };
  const window = openPage(ext, { backup });
  await until(() => status(window).dataset.state === 'error');
  assert.deepEqual(cardsOf(window).map(textOf), ['unsaved']);
  await wait(100);
  assert.equal(ext.puts.length, 0);
  ext.down = false;
  await until(() => ext.puts.length === 1);
  assert.deepEqual(ext.puts[0].map((n) => n.text).sort(), ['in file', 'unsaved']);
});

test('keystrokes typed while the load is in flight are kept and saved', async () => {
  const ext = fakeExtension([{ id: 'n-b', heading: 'Budget | Anna', text: 'in file', place: ROW }]);
  let release;
  ext.hold = new Promise((resolve) => (release = resolve));
  const window = openPage(ext);
  ext.activate();
  pressN(window, window.document.querySelector('h1'));
  type(window, cardsOf(window)[0].querySelector('textarea'), 'typed during load');
  release();
  await until(() => ext.puts.length >= 1);
  assert.deepEqual(ext.puts.at(-1).map((n) => n.text).sort(), ['in file', 'typed during load']);
  await until(() => ext.backup().dirty === false);
});

test('after a failed load, cards for notes the file no longer has are removed', async () => {
  const ext = fakeExtension([]);
  ext.down = true;
  const backup = { dirty: false, edited: [], notes: [{ id: 'n-a', heading: 'Weekly insights', text: 'deleted from file', place: H1 }] };
  const window = openPage(ext, { backup });
  await until(() => status(window).dataset.state === 'error');
  assert.deepEqual(cardsOf(window).map(textOf), ['deleted from file']);
  ext.down = false;
  await until(() => status(window).dataset.state === 'ok');
  assert.equal(cardsOf(window).length, 0);
  assert.equal(ext.puts.length, 0);
});

test('another folder picked meanwhile: its file is read first, then the unsaved note goes there', async () => {
  const ext = fakeExtension([]);
  const window = openPage(ext);
  ext.activate();
  await until(() => status(window).dataset.state === 'ok');
  ext.version = 2;
  ext.notes = [{ id: 'n-b', heading: 'Budget | Anna', text: 'already in the new folder', place: ROW }];
  pressN(window, window.document.querySelector('h1'));
  type(window, cardsOf(window)[0].querySelector('textarea'), 'typed after the switch');
  await until(() => ext.puts.length === 1);
  assert.deepEqual(ext.puts[0].map((n) => n.text).sort(), ['already in the new folder', 'typed after the switch']);
});

test('no folder chosen yet: the status says where to choose one', async () => {
  const ext = fakeExtension();
  ext.down = true;
  ext.code = 'no-folder';
  const window = openPage(ext);
  ext.activate();
  await until(() => status(window).dataset.state === 'error');
  assert.match(status(window).textContent, /No notes folder yet.*icon/);
});

test('a load answered with the file as it was before a save that finished meanwhile is read again', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Weekly insights', text: 'old', place: H1 }]);
  const window = openPage(ext);
  await until(() => status(window).dataset.state === 'ok');
  let release;
  ext.hold = new Promise((resolve) => (release = resolve));
  ext.activate(); // the side panel wakes the page again (tab switch): a second load, held open
  type(window, cardsOf(window)[0].querySelector('textarea'), 'new');
  await until(() => ext.puts.length === 1);
  await until(() => ext.backup().dirty === false);
  ext.hold = null;
  release();
  await wait(50);
  assert.deepEqual(cardsOf(window).map(textOf), ['new']);
});

test('after the page changes its address without reloading, nothing is saved into the file of the new address', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await until(() => status(window).dataset.state === 'ok');
  window.history.pushState(null, '', '/other.html');
  pressN(window, window.document.querySelector('h1'));
  type(window, cardsOf(window)[0].querySelector('textarea'), 'typed after navigation');
  await until(() => status(window).dataset.state === 'error');
  assert.match(status(window).textContent, /address changed.*[Rr]eload/);
  await wait(50);
  assert.equal(ext.puts.length, 0);
});

test('a file name taken by two other docs says so instead of a generic retry', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await until(() => status(window).dataset.state === 'ok');
  ext.down = true;
  ext.code = 'name-taken';
  pressN(window, window.document.querySelector('h1'));
  type(window, cardsOf(window)[0].querySelector('textarea'), 'x');
  await until(() => status(window).dataset.state === 'error');
  assert.match(status(window).textContent, /other docs/i);
});

test('after the page changes its address without reloading, the notes of the new address are not loaded', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Weekly insights', text: 'weekly note', place: H1 }]);
  const window = openPage(ext);
  await until(() => status(window).dataset.state === 'ok');
  window.history.pushState(null, '', '/other.html');
  ext.notes = [{ id: 'n-b', heading: 'Budget | Anna', text: 'other page note', place: ROW }]; // the worker reads /other's file
  ext.activate(); // the side panel wakes the page after the address change
  await until(() => status(window).dataset.state === 'error');
  assert.match(status(window).textContent, /address changed/);
  assert.deepEqual(cardsOf(window).map(textOf), ['weekly note']);
  window.history.pushState(null, '', '/weekly.html');
  type(window, cardsOf(window)[0].querySelector('textarea'), 'weekly note, edited');
  await until(() => ext.puts.length === 1);
  assert.deepEqual(ext.puts[0].map((n) => n.text), ['weekly note, edited']);
});

test('a new empty card keeps its place when a load lands while it is open', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await until(() => status(window).dataset.state === 'ok');
  let release;
  ext.hold = new Promise((resolve) => (release = resolve));
  ext.activate(); // a second load, held open
  pressN(window, window.document.querySelector('h1'), 30, 40);
  release();
  await wait(30);
  type(window, cardsOf(window)[0].querySelector('textarea'), 'typed after the load');
  await until(() => ext.puts.length === 1);
  assert.equal(ext.puts[0][0].heading, 'Weekly insights');
  assert.deepEqual(ext.puts[0][0].place, { at: 'h1:1', dx: 30, dy: 40 });
});
