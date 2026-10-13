// Notes as floating cards. A card sits at an offset from the element it is attached to and follows
// it when the layout changes; a card on the bare page keeps its page position. Cards whose element
// is gone wait in a tray at the top right until they are dragged to a new place.
'use strict';

const cards = new Map(); // id -> card element
let layer = null;
let tray = null;
let target = null; // outline of the element a dragged card would attach to

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

// Outside <body>, so the cards never shift the positions that note paths are made of.
function ensureLayer() {
  if (layer) return layer;
  layer = make('div', 'dn-ui dn-layer');
  const style = make('style');
  style.textContent = STYLE;
  tray = make('div', 'dn-tray');
  target = make('div', 'dn-target');
  target.hidden = true;
  layer.append(style, tray, target);
  document.documentElement.append(layer);
  return layer;
}

function renderCards() {
  dn.notes.forEach((note, id) => {
    if (!note.text.trim() && !cards.has(id)) return;
    const area = (cards.get(id) ?? makeCard(id)).querySelector('textarea');
    if (area === document.activeElement) return; // never yank text out from under the typist
    area.value = note.text;
    grow(area);
  });
  cards.forEach((card, id) => {
    const note = dn.notes.get(id);
    if ((!note || !note.text.trim()) && !card.contains(document.activeElement)) removeCard(id);
  });
  layoutCards();
}

function makeCard(id) {
  const card = make('div', 'dn-ui dn-card');
  const bar = make('div', 'dn-bar');
  const min = make('button', 'dn-min', '–');
  const del = make('button', 'dn-del', '×');
  const area = make('textarea', 'dn-text');
  min.type = del.type = 'button';
  min.title = 'Collapse or expand';
  del.title = 'Delete note';
  area.placeholder = 'Note (Markdown)';
  area.rows = 3;
  bar.append(make('span', 'dn-title'), min, del);
  card.append(bar, area);
  area.addEventListener('input', () => {
    updateNote(id, { text: area.value });
    grow(area);
  });
  area.addEventListener('blur', () => area.value.trim() || removeCard(id));
  min.addEventListener('click', () => toggleMin(id));
  del.addEventListener('click', () => deleteNote(id));
  bar.addEventListener('mousedown', (event) => startDrag(event, id));
  cards.set(id, card);
  ensureLayer().append(card);
  return card;
}

function removeCard(id) {
  const card = cards.get(id);
  if (card) card.remove();
  cards.delete(id);
}

function deleteNote(id) {
  const note = dn.notes.get(id);
  if (note && note.text.trim() && !window.confirm('Delete this note?')) return;
  removeCard(id);
  if (note) updateNote(id, { text: '' }); // empty notes are left out of the file
}

function toggleMin(id) {
  const { place } = dn.notes.get(id);
  if (!place) return; // a card without a place stays open in the tray
  const { min, ...rest } = place;
  updateNote(id, { place: min ? rest : { ...rest, min: true } });
  layoutCards();
}

/** Where a note's card goes in page coordinates, or null if its element is gone. */
function spotOf(note) {
  if (!note.place) return null;
  const { at, dx, dy } = note.place;
  if (at === undefined) return { x: dx, y: dy };
  const el = locate(at, note.heading);
  if (!el) return null;
  const corner = pageCorner(el);
  return { x: corner.x + dx, y: corner.y + dy };
}

/** Sort key for the notes file: page position, notes without a place last. */
function notePosition(note) {
  return spotOf(note) ?? { x: 0, y: Infinity };
}

function layoutCards() {
  if (!layer) return;
  const origin = pageCorner(layer);
  cards.forEach((card, id) => {
    const note = dn.notes.get(id);
    const spot = note ? spotOf(note) : null;
    card.classList.toggle('dn-lost', !spot);
    card.classList.toggle('dn-min', Boolean(note && note.place && note.place.min));
    card.querySelector('.dn-title').textContent = titleOf(note, spot);
    if (!spot) {
      if (card.parentElement !== tray) tray.append(card); // moving it again would take the focus away
      return;
    }
    if (card.parentElement !== layer) layer.append(card);
    card.style.left = spot.x - origin.x + 'px';
    card.style.top = spot.y - origin.y + 'px';
  });
}

function titleOf(note, spot) {
  if (!note) return '';
  if (!spot) return 'Place gone: ' + (note.heading || 'unknown');
  if (note.place.min) return note.text.trim().split('\n')[0];
  return note.place.at === undefined ? 'On the page' : note.heading;
}

/** What a card dropped with its top-left corner at `corner` (page coordinates) is attached to. */
// Tags such as Word's <w:sdt> or <my_el> do not fit the "tag:n/tag:n" format
const STORABLE_PATH = /^[a-z0-9-]+:\d+(\/[a-z0-9-]+:\d+)*$/;

function placeFor(el, corner, min) {
  const extra = min ? { min: true } : {};
  if (!el || !STORABLE_PATH.test(pathOf(el))) return { heading: '', place: { dx: Math.round(corner.x), dy: Math.round(corner.y), ...extra } };
  const base = pageCorner(el);
  const place = { at: pathOf(el), dx: Math.round(corner.x - base.x), dy: Math.round(corner.y - base.y), ...extra };
  return { heading: labelOf(el), place };
}

const CARD_ROOM = 260; // .dn-card width with borders, plus a scrollbar

const newId = () => 'n-' + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');

/** A new, empty card at a viewport point, attached to the element there. Saved once typed in. */
function addNoteAt(x, y) {
  activate();
  const id = newId();
  const left = Math.max(0, Math.min(x, window.innerWidth - CARD_ROOM)); // a margin note must not widen the page
  dn.notes.set(id, { text: '', ...placeFor(blockAt(x, y), { x: left + window.scrollX, y: y + window.scrollY }) });
  const area = makeCard(id).querySelector('textarea');
  layoutCards();
  area.focus();
}

function startDrag(event, id) {
  if (event.button !== 0 || event.target.closest('button')) return;
  event.preventDefault(); // no text selection while dragging
  const card = cards.get(id);
  const rect = card.getBoundingClientRect();
  const grab = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  layer.append(card); // out of the tray, if it was there
  card.classList.remove('dn-lost'); // a lost card is laid out by the tray and would not follow the pointer
  card.classList.add('dn-dragging'); // lets the pointer see the page below the card
  const cornerAt = (e) => ({ x: e.clientX - grab.x + window.scrollX, y: e.clientY - grab.y + window.scrollY });
  const move = (e) => {
    moveCard(card, cornerAt(e));
    showTarget(blockAt(e.clientX, e.clientY));
  };
  const drop = (e) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', drop);
    const onto = blockAt(e.clientX, e.clientY); // before the card is solid again and hides the page
    card.classList.remove('dn-dragging');
    showTarget(null);
    const note = dn.notes.get(id);
    updateNote(id, placeFor(onto, cornerAt(e), note.place && note.place.min));
    layoutCards();
  };
  moveCard(card, { x: rect.left + window.scrollX, y: rect.top + window.scrollY });
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', drop);
}

function moveCard(card, corner) {
  const origin = pageCorner(layer);
  card.style.left = corner.x - origin.x + 'px';
  card.style.top = corner.y - origin.y + 'px';
}

function showTarget(el) {
  target.hidden = !el;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  Object.assign(target.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
}

function grow(area) {
  area.style.height = 'auto';
  area.style.height = area.scrollHeight + 2 + 'px';
}
