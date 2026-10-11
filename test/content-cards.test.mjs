// Cards: where they sit, finding their element again, drag and drop, collapse, delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC, fakeExtension, openPage, until, wait, type, pressN, placeAt, status, cardsOf, titleOf } from './content-harness.mjs';

const ready = (window) => until(() => status(window).dataset.state === 'ok');
const px = (card) => [parseInt(card.style.left, 10), parseInt(card.style.top, 10)];

function drag(window, card, from, to, onto) {
  const bar = card.querySelector('.dn-bar');
  const mouse = (type, [x, y]) => new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  bar.dispatchEvent(mouse('mousedown', from));
  // the card sits under the pointer; only while dragging does the pointer see through it
  window.document.elementFromPoint = () => (card.classList.contains('dn-dragging') ? onto : card);
  window.document.dispatchEvent(mouse('mousemove', to));
  window.document.dispatchEvent(mouse('mouseup', to));
}

test('cards sit at their offset from their element; repeated headings told apart by position', async () => {
  const ext = fakeExtension([
    { id: 'n-a', heading: 'Was gut lief', text: 'second one', place: { at: 'h2:3', dx: 15, dy: 25 } },
    { id: 'n-b', heading: 'On the page', text: 'free', place: { dx: 700, dy: 40 } },
  ]);
  const window = openPage(ext);
  const [, , second] = window.document.querySelectorAll('h2');
  placeAt(second, 30, 500);
  await ready(window);
  const [onHeading, free] = cardsOf(window);
  assert.deepEqual(px(onHeading), [45, 525]);
  assert.equal(titleOf(onHeading), 'Was gut lief');
  assert.deepEqual(px(free), [700, 40]);
  assert.equal(titleOf(free), 'On the page');

  placeAt(second, 30, 800); // the layout changed: the card follows its heading
  window.dispatchEvent(new window.Event('resize'));
  await until(() => px(onHeading)[1] === 825);
});

test('a heading moved by new content above is found again by its text', async () => {
  const ext = fakeExtension([
    { id: 'n-a', heading: 'Where are shared reports stored?', text: 'found', place: { at: 'h2:1', dx: 0, dy: 20 } },
  ]);
  const window = openPage(ext, { doc: DOC.replace('<h1>', '<h2>New section</h2><h1>') });
  const moved = Array.from(window.document.querySelectorAll('h2')).find((h) => h.textContent.startsWith('Where'));
  placeAt(moved, 0, 300);
  await ready(window);
  const [card] = cardsOf(window);
  assert.equal(card.classList.contains('dn-lost'), false);
  assert.deepEqual(px(card), [0, 320]);
});

test('a note whose element is gone waits in the tray; dragged onto an element it is attached again', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Old topic', text: 'kept', place: { at: 'h2:9', dx: 0, dy: 0 } }]);
  const window = openPage(ext);
  await ready(window);
  const [card] = cardsOf(window);
  assert.equal(card.parentElement.className, 'dn-tray');
  assert.equal(titleOf(card), 'Place gone: Old topic');
  type(window, card.querySelector('textarea'), 'kept, edited');
  await until(() => ext.puts.length === 1);
  assert.equal(ext.puts[0][0].text, 'kept, edited');

  const h1 = window.document.querySelector('h1');
  placeAt(h1, 10, 100);
  placeAt(card, 900, 10, 240, 80);
  drag(window, card, [905, 15], [105, 215], h1); // grabbed 5px into the card
  await until(() => ext.puts.length === 2);
  assert.deepEqual(ext.puts[1][0].place, { at: 'h1:1', dx: 90, dy: 110 });
  assert.equal(ext.puts[1][0].heading, 'Weekly insights');
  assert.equal(card.classList.contains('dn-lost'), false);
});

test('dragging onto the bare page frees the card; onto a row attaches it to that cell', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Weekly insights', text: 'moving', place: { at: 'h1:1', dx: 0, dy: 30 } }]);
  const window = openPage(ext);
  await ready(window);
  const [card] = cardsOf(window);
  drag(window, card, [0, 30], [400, 600], window.document.body);
  await until(() => ext.puts.length === 1);
  assert.deepEqual(ext.puts[0][0].place, { dx: 400, dy: 570 });
  assert.equal(titleOf(card), 'On the page');

  const cell = window.document.querySelectorAll('tbody td')[1]; // "Anna"
  placeAt(cell, 200, 300);
  placeAt(card, 400, 570, 240, 80);
  drag(window, card, [400, 600], [210, 320], cell); // grabbed 30px below the card's top
  await until(() => ext.puts.length === 2);
  assert.deepEqual(ext.puts[1][0].place, { at: 'table:1/tbody:1/tr:1/td:2', dx: 10, dy: -10 });
});

test('a note on a bold word or a link is attached to its paragraph', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await ready(window);
  pressN(window, window.document.querySelector('b'));
  type(window, cardsOf(window)[0].querySelector('textarea'), 'on the paragraph');
  await until(() => ext.puts.length === 1);
  assert.equal(ext.puts[0][0].place.at, 'p:1');
  assert.equal(ext.puts[0][0].heading, 'Text with bold and a link.');
});

test('+ Note, then a click on the page places the card there; the click does not follow a link', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await ready(window);
  window.document.querySelector('.dn-add').click();
  assert.match(status(window).textContent, /Click where the note goes/);
  const link = window.document.querySelector('a');
  window.document.elementFromPoint = () => link;
  const click = new window.MouseEvent('click', { clientX: 70, clientY: 80, bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  const [card] = cardsOf(window);
  assert.deepEqual(px(card), [70, 80]);
  assert.equal(window.document.activeElement, card.querySelector('textarea'));
  assert.doesNotMatch(status(window).textContent, /Click where/);
});

test('collapse is saved with the note; delete asks, then leaves the note out of the file', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Weekly insights', text: 'first line\nmore', place: { at: 'h1:1', dx: 0, dy: 30 } }]);
  const window = openPage(ext);
  await ready(window);
  const [card] = cardsOf(window);
  card.querySelector('.dn-min').click();
  await until(() => ext.puts.length === 1);
  assert.equal(ext.puts[0][0].place.min, true);
  assert.equal(card.classList.contains('dn-min'), true);
  assert.equal(titleOf(card), 'first line');

  let asked = 0;
  window.confirm = () => (asked++, false);
  card.querySelector('.dn-del').click();
  assert.equal(cardsOf(window).length, 1, 'kept when the question is answered with No');
  window.confirm = () => (asked++, true);
  card.querySelector('.dn-del').click();
  assert.equal(asked, 2);
  assert.equal(cardsOf(window).length, 0);
  await until(() => ext.puts.length === 2);
  assert.equal(ext.puts[1][0].text, '');
});

test('an empty new card disappears when left; nothing is saved for it', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await ready(window);
  pressN(window, window.document.querySelector('h1'));
  const area = cardsOf(window)[0].querySelector('textarea');
  area.blur();
  assert.equal(cardsOf(window).length, 0);
  assert.equal(ext.puts.length, 0);
});

test('a note added near the right edge is shifted left so the card stays inside the window', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await ready(window);
  window.innerWidth = 1000;
  pressN(window, window.document.body, 990, 50);
  const [card] = cardsOf(window);
  assert.deepEqual(px(card), [740, 50]);
  type(window, card.querySelector('textarea'), 'margin note');
  await until(() => ext.puts.length === 1);
  assert.deepEqual(ext.puts[0][0].place, { dx: 740, dy: 50 });
});

test('a card dragged out of the tray follows the pointer while dragging', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Old topic', text: 'kept', place: { at: 'h2:9', dx: 0, dy: 0 } }]);
  const window = openPage(ext);
  await ready(window);
  const [card] = cardsOf(window);
  placeAt(card, 900, 10, 240, 80);
  const mouse = (type, x, y) => new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  card.querySelector('.dn-bar').dispatchEvent(mouse('mousedown', 905, 15));
  window.document.dispatchEvent(mouse('mousemove', 405, 315));
  // a lost card is laid out by the tray; while dragged it must be placed by its left/top
  assert.equal(card.classList.contains('dn-lost'), false);
  assert.deepEqual(px(card), [400, 310]);
  window.document.dispatchEvent(mouse('mouseup', 405, 315));
});

test('relayout leaves a card that is already in the tray where it is, so typing in it keeps focus', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Old topic', text: 'kept', place: { at: 'h2:9', dx: 0, dy: 0 } }]);
  const window = openPage(ext);
  await ready(window);
  const area = cardsOf(window)[0].querySelector('textarea');
  area.focus();
  window.dispatchEvent(new window.Event('resize'));
  await wait(50);
  assert.equal(window.document.activeElement, area);
});

test('an element whose tag cannot be stored in a path gets a note at that page spot instead', async () => {
  const ext = fakeExtension();
  const window = openPage(ext, { doc: DOC.replace('<h1>', '<w:sdt><div>Word bit</div></w:sdt><my_el>odd</my_el><h1>') });
  ext.activate();
  await ready(window);
  for (const el of [window.document.querySelector('div'), window.document.querySelector('my_el')]) {
    pressN(window, el, 30, 40);
    type(window, cardsOf(window).at(-1).querySelector('textarea'), 'on ' + el.tagName);
  }
  await until(() => ext.puts.length >= 1 && ext.puts.at(-1).length === 2);
  assert.deepEqual(ext.puts.at(-1).map((n) => n.place), [{ dx: 30, dy: 40 }, { dx: 30, dy: 40 }]);
});

test('a long label is cut between characters, never inside an emoji', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await ready(window);
  const h1 = window.document.querySelector('h1');
  h1.textContent = 'a'.repeat(79) + '😀 rest';
  pressN(window, h1);
  type(window, cardsOf(window)[0].querySelector('textarea'), 'emoji');
  await until(() => ext.puts.length === 1);
  assert.equal(ext.puts[0][0].heading, 'a'.repeat(79) + '😀');
});

test('a click on the bar without moving leaves the note where it is attached', async () => {
  const ext = fakeExtension([{ id: 'n-a', heading: 'Weekly insights', text: 'stays', place: { at: 'h1:1', dx: 0, dy: 30 } }]);
  const window = openPage(ext);
  await ready(window);
  const [card] = cardsOf(window);
  const p = window.document.querySelector('p'); // what lies under the card
  const mouse = (type) => new window.MouseEvent(type, { clientX: 20, clientY: 40, button: 0, bubbles: true });
  window.document.elementFromPoint = () => (card.classList.contains('dn-dragging') ? p : card);
  card.querySelector('.dn-bar').dispatchEvent(mouse('mousedown'));
  window.document.dispatchEvent(mouse('mouseup'));
  await wait(50);
  assert.equal(ext.puts.length, 0);
  assert.equal(card.classList.contains('dn-dragging'), false);
});

test('a note on an image or a drawing is attached to it, not to its paragraph', async () => {
  const ext = fakeExtension();
  const doc = DOC.replace('b,span,a{display:inline}', 'b,span,a,img,svg,rect{display:inline}')
    .replace('<h1>', '<p>See <img src="chart.png" alt="chart"> and <svg><rect width="5" height="5"/></svg></p><h1>');
  const window = openPage(ext, { doc });
  ext.activate();
  await ready(window);
  for (const el of [window.document.querySelector('img'), window.document.querySelector('rect')]) {
    pressN(window, el);
    type(window, cardsOf(window).at(-1).querySelector('textarea'), 'on ' + el.tagName);
  }
  await until(() => ext.puts.length >= 1 && ext.puts.at(-1).length === 2);
  assert.deepEqual(ext.puts.at(-1).map((n) => n.place.at).sort(), ['p:1/img:1', 'p:1/svg:1']);
});

test('grabbing the bar of a new card keeps the caret in it, so an empty card survives being dragged', async () => {
  const ext = fakeExtension();
  const window = openPage(ext);
  ext.activate();
  await ready(window);
  pressN(window, window.document.querySelector('h1'));
  const [card] = cardsOf(window);
  const area = card.querySelector('textarea');
  drag(window, card, [12, 12], [200, 300], null);
  assert.equal(window.document.activeElement, area);
  assert.equal(cardsOf(window).length, 1);
});

test('a shape is attached to its drawing, but HTML inside the drawing to its own block', async () => {
  const ext = fakeExtension();
  const doc = DOC.replace('<h1>', '<svg><rect width="5" height="5"/><foreignObject><div>In the drawing</div></foreignObject></svg><h1>');
  const window = openPage(ext, { doc });
  ext.activate();
  await ready(window);
  for (const el of [window.document.querySelector('rect'), window.document.querySelector('foreignObject div')]) {
    pressN(window, el);
    type(window, cardsOf(window).at(-1).querySelector('textarea'), 'on ' + el.tagName);
  }
  await until(() => ext.puts.length >= 1 && ext.puts.at(-1).length === 2);
  assert.deepEqual(ext.puts.at(-1).map((n) => n.place.at).sort(), ['svg:1', 'svg:1/foreignobject:1/div:1']);
});
