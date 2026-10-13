// The notes file: one Markdown file per doc, readable by humans and read back by the extension.
// Pure functions, shared by the background worker and the Node tests.

const ID = /^[a-z0-9][a-z0-9-]*$/;
const AT = /^[a-z0-9:/-]*$/;
const MARKER = /^<!--\s*note:([a-z0-9][a-z0-9-]*)\s*(\{.*\})?\s*-->\s*$/;
const DOC_LINE = /^<!--\s*doc:\s*(\S+)\s*-->\s*$/;
const HEADING = /^##\s+/;
const HEADER_LINE = /^(# Notes: .*|_Last saved .*_|<!--\s*doc:.*-->)\s*$/;
const FREE_LABEL = 'On the page';

/** The page a notes file belongs to: the URL without #fragment; file:// also without ?query. */
export function docKey(url) {
  const u = new URL(url);
  u.hash = '';
  if (u.protocol === 'file:') u.search = '';
  return u.href;
}

/**
 * File name for a doc's notes: file:///a/plan.html -> "plan.notes.md",
 * https://wiki.example/x/page?id=1 -> "wiki.example - x - page - id=1.notes.md".
 */
export function notesFileName(url) {
  const u = new URL(docKey(url));
  const segments = u.pathname.split('/').filter(Boolean).map(decodeSegment);
  const parts = u.protocol === 'file:' ? segments.slice(-1) : [u.hostname, ...segments];
  if (u.search) parts.push(u.search.slice(1));
  const name = parts
    .join(' - ')
    .replace(/\.html?$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .slice(0, 120)
    .trim();
  return (name || 'page') + '.notes.md';
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed %-escape: the raw text is still a usable name
  }
}

/**
 * Render notes ({ id, heading, text, place }[]) as the notes file. Empty notes are left out.
 * `place` is { at?, dx, dy, min? }: `at` is the element path, without it dx/dy are page coordinates.
 * `preamble` is hand-written text kept between the header and the first note.
 */
export function renderNotes(url, notes, { savedAt = new Date(), preamble = '' } = {}) {
  const blocks = notes
    .filter((note) => note.text.trim() !== '')
    .map((note) => {
      const label = note.place && !note.place.at ? FREE_LABEL : oneLine(note.heading) || note.id;
      const place = note.place ? ' ' + JSON.stringify(note.place) : '';
      return `## ${label}\n<!-- note:${note.id}${place} -->\n\n${note.text.trim()}\n`;
    });
  const intro = preamble.trim() ? `${preamble.trim()}\n\n` : '';
  const title = `# Notes: ${titleOf(url)}\n<!-- doc: ${docKey(url)} -->`;
  return `${title}\n\n_Last saved ${formatStamp(savedAt)}_\n\n${intro}${blocks.join('\n')}`;
}

/** The doc URL a notes file was written for, or null for files without the doc line. */
export function parseDocUrl(markdown) {
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(DOC_LINE);
    if (match) return match[1];
    if (MARKER.test(line)) return null;
  }
  return null;
}

/** Hand-written text above the first note, without the generated title, doc and "Last saved" lines. */
export function parsePreamble(markdown) {
  const lines = markdown.split(/\r?\n/);
  let end = lines.findIndex((line) => MARKER.test(line));
  if (end === -1) end = lines.length;
  else if (HEADING.test(lines[end - 1] ?? '')) end -= 1;
  return lines.slice(0, end).filter((line) => !HEADER_LINE.test(line)).join('\n').trim();
}

/**
 * Parse a notes file back into { id, heading, text, place }[]. The marker line is what counts;
 * the ## line right above it is the heading. A marker without a valid place gives place null.
 */
export function parseNotes(markdown) {
  const lines = markdown.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => (MARKER.test(line) ? [i] : []));
  return starts.map((start, k) => {
    const next = starts[k + 1];
    // the next note's ## line belongs to the next note, not to this note's text
    const end = next === undefined ? lines.length : HEADING.test(lines[next - 1]) ? next - 1 : next;
    const above = lines[start - 1] ?? '';
    const [, id, placeJson] = lines[start].match(MARKER);
    return {
      id,
      heading: HEADING.test(above) ? above.replace(HEADING, '').trim() : '',
      text: lines.slice(start + 1, end).join('\n').trim(),
      place: validPlace(parseJson(placeJson)),
    };
  });
}

/** Notes as sent by a page, checked field by field; null if anything is off. */
export function validNotes(notes) {
  if (!Array.isArray(notes)) return null;
  const valid = notes.every(
    (n) => n && ID.test(n.id) && typeof n.heading === 'string' && typeof n.text === 'string',
  );
  if (!valid) return null;
  const clean = notes.map(({ id, heading, text, place }) => ({ id, heading, text, place: validPlace(place) }));
  return clean.every((n, i) => n.place !== null || notes[i].place == null) ? clean : null;
}

function validPlace(place) {
  if (!place || typeof place !== 'object') return null;
  const { at, dx, dy, min } = place;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (at !== undefined && (typeof at !== 'string' || !AT.test(at))) return null;
  const clean = {}; // key order at, dx, dy, min: stable JSON in the file
  if (at !== undefined) clean.at = at;
  clean.dx = Math.round(dx);
  clean.dy = Math.round(dy);
  if (min === true) clean.min = true;
  return clean;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null; // hand-broken position: the note shows as "place gone" and can be dragged back
  }
}

function titleOf(url) {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop();
  return last ? oneLine(decodeSegment(last)) : u.hostname; // %0A in the address must not add lines
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
