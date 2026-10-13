// client.js in jsdom against a fake server: no port, no real browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const KEY = 'decision-notes:/weekly.html';
const DOC = `<!doctype html><html><head></head><body>
<h1>Weekly insights</h1>
<h2>Where are shared reports stored?</h2><p>Text.</p>
<h2>Was gut lief</h2><p>A</p>
<h2>Was gut lief</h2><p>B</p>
<table><thead><tr><th>Topic</th><th>Owner</th></tr></thead>
<tbody><tr><td>Budget</td><td>Anna</td></tr><tr><td>Hiring</td><td>Ben</td></tr></tbody></table>
</body></html>`;

function fakeServer(notes = []) {
  const server = { notes, down: false, puts: [], gets: 0 };
  server.fetch = async (url, options = {}) => {
    assert.equal(url, '/__notes/data?doc=%2Fweekly.html');
    if (server.down) throw new TypeError('Failed to fetch');
    if (options.method === 'PUT') {
      server.notes = JSON.parse(options.body).notes;
      server.puts.push(server.notes);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    await server.hold; // a test can hold the load open to type during it
    server.gets++;
    return { ok: true, status: 200, json: async () => ({ notes: server.notes }) };
  };
  return server;
}

// Every window is closed after its test, or its retry timers keep the run alive.
const windows = [];
after(() => windows.forEach((window) => window.close()));

function openDoc(server, backup) {
  const dom = new JSDOM(DOC, { url: 'http://localhost:4321/weekly.html', runScripts: 'outside-only' });
  const { window } = dom;
  window.fetch = server.fetch;
  window.DECISION_NOTES_CONFIG = { saveDelay: 20, retryDelay: 60 };
  window.console.warn = () => {}; // expected warnings while the fake server is down
  if (backup) window.localStorage.setItem(KEY, JSON.stringify(backup));
  window.eval(CLIENT);
  windows.push(window);
  return window;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 1000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + check);
    await wait(5);
  }
}

function type(window, area, text) {
  area.value = text;
  area.dispatchEvent(new window.Event('input', { bubbles: true }));
}

// the pill appears on DOMContentLoaded, which jsdom fires after the script ran
const status = (window) => window.document.querySelector('.dn-status') ?? { dataset: {}, textContent: '' };
const backupOf = (window) => JSON.parse(window.localStorage.getItem(KEY));
const headings = (window) => window.document.querySelectorAll('h2');

test('loads notes from the file into place, repeated headings by order', async () => {
  const server = fakeServer([
    { id: 'where-are-shared-reports-stored', heading: 'Where are shared reports stored?', text: 'Backend ok' },
    { id: 'was-gut-lief-2', heading: 'Was gut lief', text: 'second one' },
    { id: 'budget-anna', heading: 'Budget | Anna', text: 'row note' },
  ]);
  const window = openDoc(server);
  await until(() => status(window).dataset.state === 'ok');
  const [reports, first, second] = headings(window);
  assert.equal(reports.nextElementSibling.querySelector('textarea').value, 'Backend ok');
  assert.equal(first.nextElementSibling.tagName, 'P');
  assert.equal(second.nextElementSibling.querySelector('textarea').value, 'second one');
  const row = window.document.querySelector('tbody tr');
  assert.equal(row.nextElementSibling.className, 'dn-ui dn-box dn-row');
  assert.equal(row.nextElementSibling.querySelector('td').colSpan, 2);
  assert.equal(row.nextElementSibling.querySelector('textarea').value, 'row note');
  assert.equal(server.puts.length, 0);
});

test('notes whose anchor is gone go to the orphans box and stay editable', async () => {
  const server = fakeServer([{ id: 'old-topic', heading: 'Old topic', text: 'kept' }]);
  const window = openDoc(server);
  await until(() => status(window).dataset.state === 'ok');
  const box = window.document.querySelector('.dn-orphans');
  assert.match(box.textContent, /Notes whose place is gone/);
  assert.match(box.textContent, /Old topic/);
  type(window, box.querySelector('textarea'), 'kept, edited');
  await until(() => server.puts.length === 1);
  assert.deepEqual(server.puts[0], [{ id: 'old-topic', heading: 'Old topic', text: 'kept, edited' }]);
});

test('N on a hovered table row adds a note: backup at once, debounced save, then clean', async () => {
  const server = fakeServer();
  const window = openDoc(server);
  const { document } = window;
  await until(() => status(window).dataset.state === 'ok');
  const cell = document.querySelectorAll('tbody td')[2]; // "Hiring"
  cell.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(document.querySelector('.dn-add').hidden, false);
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  const area = cell.parentElement.nextElementSibling.querySelector('textarea');
  assert.equal(document.activeElement, area);

  type(window, area, 'Ben');
  type(window, area, 'Ben starts in May');
  assert.equal(backupOf(window).dirty, true);
  assert.equal(backupOf(window).notes[0].text, 'Ben starts in May');
  assert.equal(server.puts.length, 0); // debounced, not yet
  await until(() => server.puts.length === 1);
  await wait(40);
  assert.equal(server.puts.length, 1); // two keystrokes, one save
  assert.deepEqual(server.puts[0], [{ id: 'hiring-ben', heading: 'Hiring | Ben', text: 'Ben starts in May' }]);
  assert.equal(backupOf(window).dirty, false);
  assert.match(status(window).textContent, /^Saved \d\d:\d\d$/);
});

test('N is ignored while typing in a field; + click opens the hovered note', async () => {
  const server = fakeServer();
  const window = openDoc(server);
  const { document } = window;
  await until(() => status(window).dataset.state === 'ok');
  const [reports] = headings(window);
  reports.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  const input = document.createElement('input');
  document.body.append(input);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  assert.equal(document.querySelectorAll('.dn-note').length, 0);
  document.querySelector('.dn-add').click();
  assert.equal(document.querySelectorAll('.dn-note').length, 1);
  assert.equal(reports.nextElementSibling.className, 'dn-ui dn-box dn-note');
});

test('server down: status turns red, text stays in the backup, retry saves it later', async () => {
  const server = fakeServer();
  const window = openDoc(server);
  await until(() => status(window).dataset.state === 'ok');
  server.down = true;
  const [reports] = headings(window);
  reports.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'N', bubbles: true }));
  type(window, reports.nextElementSibling.querySelector('textarea'), 'typed while down');
  await until(() => status(window).dataset.state === 'error');
  assert.equal(backupOf(window).dirty, true);
  server.down = false;
  await until(() => server.puts.length === 1);
  assert.equal(server.puts[0][0].text, 'typed while down');
  await until(() => status(window).dataset.state === 'ok');
});

test('on load, unsaved browser edits win per note and are pushed; other file notes stay', async () => {
  const server = fakeServer([
    { id: 'weekly-insights', heading: 'Weekly insights', text: 'file version' },
    { id: 'budget-anna', heading: 'Budget | Anna', text: 'only in file' },
  ]);
  const backup = {
    dirty: true,
    edited: ['weekly-insights'],
    notes: [{ id: 'weekly-insights', heading: 'Weekly insights', text: 'browser version' }],
  };
  const window = openDoc(server, backup);
  await until(() => server.puts.length === 1);
  const h1 = window.document.querySelector('h1');
  assert.equal(h1.nextElementSibling.querySelector('textarea').value, 'browser version');
  assert.deepEqual(
    server.puts[0].map((n) => n.text),
    ['browser version', 'only in file'],
  );
});

test('on load without unsaved edits the file wins, so hand edits show up', async () => {
  const server = fakeServer([{ id: 'weekly-insights', heading: 'Weekly insights', text: 'edited by hand' }]);
  const backup = { dirty: false, notes: [{ id: 'weekly-insights', heading: 'Weekly insights', text: 'old' }] };
  const window = openDoc(server, backup);
  await until(() => status(window).dataset.state === 'ok');
  const h1 = window.document.querySelector('h1');
  assert.equal(h1.nextElementSibling.querySelector('textarea').value, 'edited by hand');
  assert.equal(server.puts.length, 0);
});

test('server down at load: shows the backup, never saves before the file was read', async () => {
  const server = fakeServer([{ id: 'budget-anna', heading: 'Budget | Anna', text: 'in file' }]);
  server.down = true;
  const backup = {
    dirty: true,
    edited: ['weekly-insights'],
    notes: [{ id: 'weekly-insights', heading: 'Weekly insights', text: 'unsaved' }],
  };
  const window = openDoc(server, backup);
  await until(() => status(window).dataset.state === 'error');
  const h1 = window.document.querySelector('h1');
  assert.equal(h1.nextElementSibling.querySelector('textarea').value, 'unsaved');
  await wait(100);
  assert.equal(server.puts.length, 0);
  server.down = false;
  await until(() => server.puts.length === 1);
  assert.deepEqual(server.puts[0].map((n) => n.text), ['unsaved', 'in file']);
});

test('keystrokes typed while the load is in flight are kept and saved', async () => {
  const server = fakeServer([{ id: 'budget-anna', heading: 'Budget | Anna', text: 'in file' }]);
  let release;
  server.hold = new Promise((resolve) => (release = resolve));
  const window = openDoc(server);
  await until(() => status(window).dataset.state === 'saving' || window.document.querySelector('.dn-add'));
  const h1 = window.document.querySelector('h1');
  h1.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  type(window, h1.nextElementSibling.querySelector('textarea'), 'typed during load');
  release();
  await until(() => server.puts.length === 1);
  assert.deepEqual(server.puts[0].map((n) => n.text), ['typed during load', 'in file']);
  await until(() => backupOf(window).dirty === false);
  assert.equal(backupOf(window).notes[0].text, 'typed during load');
});

test('after a failed load, boxes for notes the file no longer has are removed', async () => {
  const server = fakeServer([]);
  server.down = true;
  const backup = { dirty: false, notes: [{ id: 'weekly-insights', heading: 'Weekly insights', text: 'deleted from file' }] };
  const window = openDoc(server, backup);
  await until(() => status(window).dataset.state === 'error');
  const h1 = window.document.querySelector('h1');
  assert.equal(h1.nextElementSibling.querySelector('textarea').value, 'deleted from file');
  server.down = false;
  await until(() => status(window).dataset.state === 'ok');
  assert.equal(h1.nextElementSibling.tagName, 'H2');
  assert.equal(server.puts.length, 0);
});

test('clearing the last orphan removes the orphans box', async () => {
  const server = fakeServer([{ id: 'old-topic', heading: 'Old topic', text: 'kept' }]);
  const window = openDoc(server);
  await until(() => status(window).dataset.state === 'ok');
  const area = window.document.querySelector('.dn-orphans textarea');
  area.focus();
  type(window, area, '');
  area.blur();
  assert.equal(window.document.querySelector('.dn-orphans'), null);
  await until(() => server.puts.length === 1);
  assert.deepEqual(server.puts[0], [{ id: 'old-topic', heading: 'Old topic', text: '' }]);
});

test('on load, only notes edited in the browser win; untouched backup copies do not undo hand edits', async () => {
  const server = fakeServer([
    { id: 'weekly-insights', heading: 'Weekly insights', text: 'file version' },
    { id: 'budget-anna', heading: 'Budget | Anna', text: 'edited by hand' },
  ]);
  const backup = {
    dirty: true,
    edited: ['weekly-insights'],
    notes: [
      { id: 'weekly-insights', heading: 'Weekly insights', text: 'typed, not saved' },
      { id: 'budget-anna', heading: 'Budget | Anna', text: 'stale copy' },
    ],
  };
  const window = openDoc(server, backup);
  await until(() => server.puts.length === 1);
  assert.deepEqual(server.puts[0].map((n) => n.text), ['typed, not saved', 'edited by hand']);
});

test('a heading whose text ends in a number does not share an ID with a repeat', async () => {
  const doc = '<!doctype html><body><h2>Option</h2><h2>Option 2</h2><h2>Option</h2></body>';
  const server = fakeServer([{ id: 'option-2', heading: 'Option 2', text: 'for option 2' }]);
  const dom = new JSDOM(doc, { url: 'http://localhost:4321/weekly.html', runScripts: 'outside-only' });
  const { window } = dom;
  windows.push(window);
  window.fetch = server.fetch;
  window.eval(CLIENT);
  await until(() => status(window).dataset.state === 'ok');
  const [, second, third] = window.document.querySelectorAll('h2');
  assert.equal(second.nextElementSibling.querySelector('textarea').value, 'for option 2');
  assert.equal(third.nextElementSibling.classList.contains('dn-box'), false);
});

test('leaving the anchors hides the + and N adds nothing; moving onto the + keeps it', async () => {
  const window = openDoc(fakeServer());
  const { document } = window;
  await until(() => status(window).dataset.state === 'ok');
  const add = document.querySelector('.dn-add');
  const hover = (el) => el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  const [reports] = headings(window);
  hover(reports);
  hover(add);
  assert.equal(add.hidden, false, 'the + stays while the pointer is on it');
  hover(reports.nextElementSibling); // the <p> below: no anchor
  assert.equal(add.hidden, true);
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  assert.equal(document.querySelectorAll('.dn-note').length, 0);
});
