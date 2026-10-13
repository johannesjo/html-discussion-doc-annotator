#!/usr/bin/env node
// Decision notes server: serves the HTML docs of one folder with the note layer injected,
// and reads/writes <doc>.notes.md next to each doc. Node 18+, no dependencies.
//
// Usage: node serve.mjs [root]   (root defaults to the current folder; PORT env, default 4321)
import { createServer } from 'node:http';
import { realpathSync, statSync } from 'node:fs';
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CLIENT_PATH = fileURLToPath(new URL('./client.js', import.meta.url));
const CLIENT_TAG = '<script src="/__notes/client.js"></script>';
const MAX_BODY = 5 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const MARKER = /^<!--\s*note:([a-z0-9][a-z0-9-]*)\s*-->\s*$/;
const HEADING = /^##\s+/;
const HEADER_LINE = /^(# Notes: .*|_Last saved .*_)\s*$/;
const TYPES = {
  text: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/**
 * Resolve a doc name from a URL to an absolute path, or null if it is not an .html file
 * inside root. Decodes first, so an encoded ../ is caught by the containment check.
 */
export function resolveDoc(root, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null; // malformed %-escape: not a doc name we could have linked to
  }
  if (decoded.includes('\0') || !/\.html$/i.test(decoded)) return null;
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, decoded.replace(/^[/\\]+/, ''));
  return full.startsWith(rootAbs + path.sep) ? full : null;
}

/** Path of the notes file that belongs to a doc: plan.html -> plan.notes.md */
export function notesPathFor(docPath) {
  return docPath.replace(/\.html$/i, '.notes.md');
}

/**
 * Render notes ({ id, heading, text }[]) as the Markdown notes file. Empty notes are left out.
 * `preamble` is hand-written text kept between the header and the first note.
 */
export function renderNotes(docName, notes, { savedAt = new Date(), preamble = '' } = {}) {
  const blocks = notes
    .filter((note) => note.text.trim() !== '')
    .map((note) => `## ${oneLine(note.heading) || note.id}\n<!-- note:${note.id} -->\n\n${note.text.trim()}\n`);
  const intro = preamble.trim() ? `${preamble.trim()}\n\n` : '';
  return `# Notes: ${docName}\n\n_Last saved ${formatStamp(savedAt)}_\n\n${intro}${blocks.join('\n')}`;
}

/** Hand-written text above the first note, without the generated title and "Last saved" lines. */
export function parsePreamble(markdown) {
  const lines = markdown.split(/\r?\n/);
  let end = lines.findIndex((line) => MARKER.test(line));
  if (end === -1) end = lines.length;
  else if (HEADING.test(lines[end - 1] ?? '')) end -= 1;
  return lines.slice(0, end).filter((line) => !HEADER_LINE.test(line)).join('\n').trim();
}

/**
 * Parse a notes file back into { id, heading, text }[]. The marker line is what counts;
 * the ## line right above it is the heading. Everything else is note text.
 */
export function parseNotes(markdown) {
  const lines = markdown.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => (MARKER.test(line) ? [i] : []));
  return starts.map((start, k) => {
    const next = starts[k + 1];
    // the next note's ## line belongs to the next note, not to this note's text
    const end = next === undefined ? lines.length : HEADING.test(lines[next - 1]) ? next - 1 : next;
    const above = lines[start - 1] ?? '';
    return {
      id: lines[start].match(MARKER)[1],
      heading: HEADING.test(above) ? above.replace(HEADING, '').trim() : '',
      text: lines.slice(start + 1, end).join('\n').trim(),
    };
  });
}

/** Add the client script tag before </body>; the file on disk is never touched. */
export function injectClient(html) {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? html + CLIENT_TAG : html.slice(0, at) + CLIENT_TAG + html.slice(at);
}

/** Request handler for a docs folder. Exported so tests can mount it on any port. */
export function createHandler(root) {
  const rootAbs = path.resolve(root);
  return async (req, res) => {
    try {
      await route(req, res, rootAbs);
    } catch (err) {
      if (!err.status) console.error(err);
      send(res, err.status ?? 500, TYPES.text, err.status ? err.message : 'Server error');
    }
  };
}

async function route(req, res, root) {
  // Host check: stops a web page from reaching this server through DNS rebinding
  if (!isLocalHost(req.headers.host)) return send(res, 403, TYPES.text, 'Forbidden host');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__notes/data') return handleData(req, res, root, url.searchParams.get('doc') ?? '');
  if (req.method !== 'GET') return send(res, 405, TYPES.text, 'Method not allowed');
  if (url.pathname === '/__notes/client.js') return send(res, 200, TYPES.js, await readFile(CLIENT_PATH));
  if (url.pathname === '/') return send(res, 200, TYPES.html, renderIndex(await listDocs(root)));
  const docPath = resolveDoc(root, url.pathname);
  const html = docPath ? await readOrNull(docPath) : null;
  if (html === null) return send(res, 404, TYPES.text, 'Not found');
  return send(res, 200, TYPES.html, injectClient(html));
}

async function handleData(req, res, root, doc) {
  const docPath = resolveDoc(root, doc);
  if (!docPath || !(await isFile(docPath))) return send(res, 404, TYPES.text, 'No such doc');
  const notesPath = notesPathFor(docPath);
  if (req.method === 'GET') {
    const notes = parseNotes((await readOrNull(notesPath)) ?? '');
    return send(res, 200, TYPES.json, JSON.stringify({ notes }));
  }
  if (req.method !== 'PUT') return send(res, 405, TYPES.text, 'Method not allowed');
  const notes = validNotes(parseJson(await readBody(req))?.notes);
  if (!notes) return send(res, 400, TYPES.text, 'Expected { notes: [{ id, heading, text }] }');
  const preamble = parsePreamble((await readOrNull(notesPath)) ?? '');
  await writeAtomic(notesPath, renderNotes(path.basename(docPath), notes, { preamble }));
  return send(res, 200, TYPES.json, JSON.stringify({ ok: true }));
}

function validNotes(notes) {
  if (!Array.isArray(notes)) return null;
  const valid = notes.every(
    (n) => n && ID.test(n.id) && typeof n.heading === 'string' && typeof n.text === 'string',
  );
  return valid ? notes.map(({ id, heading, text }) => ({ id, heading, text })) : null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null; // caller answers 400
  }
}

function isLocalHost(host) {
  try {
    const name = new URL(`http://${host}`).hostname;
    return name === 'localhost' || name === '127.0.0.1';
  } catch {
    return false; // missing or malformed Host: refuse like a foreign one
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) return reject(Object.assign(new Error('Body too large'), { status: 413 }));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readOrNull(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// tmp file + rename: a crash mid-write never leaves a half-written notes file.
// One tmp name per write, so overlapping saves cannot mix; the last rename wins.
async function writeAtomic(file, content) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

async function listDocs(root, dir = '') {
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') return []; // unreadable folder: just skip it
    throw err;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
      if (entry.isDirectory()) return listDocs(root, rel);
      return /\.html$/i.test(entry.name) ? [rel] : [];
    }),
  );
  return nested.flat().sort();
}

function renderIndex(docs) {
  // per segment: encodeURI would leave # and ? in a file name unescaped
  const href = (doc) => doc.split('/').map(encodeURIComponent).join('/');
  const items = docs.map((doc) => `<li><a href="/${href(doc)}">${escapeHtml(doc)}</a></li>`);
  const list = items.length ? `<ul>\n${items.join('\n')}\n</ul>` : '<p>No .html files in this folder.</p>';
  return `<!doctype html>\n<meta charset="utf-8">\n<title>Decision notes</title>\n<h1>Decision notes</h1>\n${list}\n`;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const port = Number(process.env.PORT ?? 4321);
  // fail at start, not with a 500 on the first page view
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Docs folder not found: ${root}`);
    process.exitCode = 1;
    return;
  }
  createServer(createHandler(root)).listen(port, '127.0.0.1', () => {
    console.log(`Decision notes on http://localhost:${port}/  (docs from ${root})`);
  });
}

// realpath: Node resolves symlinks for import.meta.url, so a symlinked start path must match too
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
