// The content scripts in jsdom against a fake background worker: no Chrome, no files.
// jsdom has no layout: tests stub elementFromPoint and getBoundingClientRect where position matters.
import { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const CONTENT = manifest.content_scripts[0].js
  .map((file) => readFileSync(new URL('../extension/' + file, import.meta.url), 'utf8'))
  .join('\n;\n');

export const KEY = 'decision-notes:http://localhost/weekly.html';
// jsdom computes "" for inline elements; Chrome says "inline", so the page states it
export const DOC = `<!doctype html><html><head><style>b,span,a{display:inline}</style></head><body>
<h1>Weekly insights</h1>
<h2>Where are shared reports stored?</h2><p>Text with <b>bold</b> and a <a href="/x">link</a>.</p>
<h2>Was gut lief</h2><p>A</p>
<h2>Was gut lief</h2><p>B</p>
<table><thead><tr><th>Topic</th><th>Owner</th></tr></thead>
<tbody><tr><td>Budget</td><td>Anna</td></tr><tr><td>Hiring</td><td>Ben</td></tr></tbody></table>
</body></html>`;

/** Fake background worker and chrome.storage. `down` + `code` make every call fail with that code. */
export function fakeExtension(notes = []) {
  const ext = { notes, down: false, code: 'failed', puts: [], loads: 0, version: 1, hold: null, listeners: [] };
  const storage = new Map();
  const send = async (message) => {
    const read = structuredClone(ext.notes); // the file as read; the answer can be held back (ext.hold)
    if (message.type === 'load') await ext.hold;
    if (ext.down) return { ok: false, error: ext.code, message: 'fake failure' };
    if (message.type === 'load') {
      ext.loads++;
      return { ok: true, notes: read, folder: 'meetings', version: ext.version };
    }
    if (message.version !== ext.version) return { ok: false, error: 'folder-changed', message: 'changed' };
    ext.notes = structuredClone(message.notes);
    ext.puts.push(ext.notes);
    return { ok: true, file: 'weekly.notes.md' };
  };
  ext.chrome = {
    runtime: { sendMessage: send, onMessage: { addListener: (fn) => ext.listeners.push(fn) } },
    storage: {
      local: {
        get: async (key) => (storage.has(key) ? { [key]: structuredClone(storage.get(key)) } : {}),
        set: async (items) => Object.entries(items).forEach(([k, v]) => storage.set(k, structuredClone(v))),
      },
    },
  };
  ext.backup = () => storage.get(KEY);
  ext.setBackup = (value) => storage.set(KEY, value);
  ext.activate = () => ext.listeners.forEach((fn) => fn({ type: 'activate' }));
  return ext;
}

// Every window is closed after the run, or its retry timers keep it alive.
const windows = [];
after(() => windows.forEach((window) => window.close()));

export function openPage(ext, { doc = DOC, backup } = {}) {
  const { window } = new JSDOM(doc, { url: 'http://localhost/weekly.html', runScripts: 'outside-only', pretendToBeVisual: true });
  windows.push(window);
  window.chrome = ext.chrome;
  window.DECISION_NOTES_CONFIG = { saveDelay: 20, retryDelay: 60 };
  window.console.warn = () => {}; // expected warnings while the fake worker fails
  window.document.elementFromPoint = () => null;
  if (backup) ext.setBackup(backup);
  window.eval(CONTENT);
  return window;
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check, ms = 1000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + check);
    await wait(5);
  }
}

export function type(window, area, text) {
  area.value = text;
  area.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Put an element at a viewport rectangle, as layout would. */
export function placeAt(el, left, top, width = 100, height = 20) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height });
}

/** Move the mouse over `el` at (x, y) and press N there. */
export function pressN(window, el, x = 10, y = 10) {
  window.document.elementFromPoint = () => el;
  window.document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
}

export const status = (window) => window.document.querySelector('.dn-status') ?? { dataset: {}, textContent: '' };
export const cardsOf = (window) => Array.from(window.document.querySelectorAll('.dn-card'));
export const textOf = (card) => card.querySelector('textarea').value;
export const titleOf = (card) => card.querySelector('.dn-title').textContent;
