// Finding a note's element again after a reload. A note stores the element's path (tag and
// position per level, "main:1/h2:3") and its text; the text check catches a path that now points
// at something else because elements were inserted above, and then the text is searched for.
'use strict';

const UI_SELECTOR = '.dn-ui';

/** Text that identifies an element: table rows as their cells joined by " | ", at most 80 characters. */
function labelOf(el) {
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const text =
    el.tagName === 'TR'
      ? Array.from(el.cells, (cell) => clean(cell.textContent)).filter(Boolean).join(' | ')
      : clean(el.textContent);
  // cut by characters: half an emoji would not survive the file, and the label would never match again
  return Array.from(text).slice(0, 80).join('').trim() || `<${el.tagName.toLowerCase()}>`;
}

/** Path from below <body> down to `el`: tag and 1-based position among same-tag siblings. */
function pathOf(el) {
  const steps = [];
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    steps.unshift(`${node.tagName.toLowerCase()}:${sameTagIndex(node)}`);
  }
  return steps.join('/');
}

function sameTagIndex(el) {
  const same = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
  return same.indexOf(el) + 1;
}

function resolvePath(path) {
  let node = document.body;
  for (const step of path.split('/').filter(Boolean)) {
    const [tag, n] = step.split(':');
    node = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === tag)[Number(n) - 1];
    if (!node) return null;
  }
  return node;
}

/** The element a note was attached to, or null if its place is gone. */
function locate(at, label) {
  const el = resolvePath(at);
  if (el && labelOf(el) === label) return el;
  const tag = at.split('/').pop().split(':')[0];
  if (!tag || /^<.*>$/.test(label)) return null; // no text to search for: only the path counts
  const twins = Array.from(document.body.getElementsByTagName(tag)).filter(
    (c) => !c.closest(UI_SELECTOR) && labelOf(c) === label,
  );
  // repeated texts ("Was gut lief" twice): take the one nearest the old position
  const was = Number(at.split(':').pop());
  twins.sort((a, b) => Math.abs(sameTagIndex(a) - was) - Math.abs(sameTagIndex(b) - was));
  return twins[0] ?? null;
}

/** The element under a viewport point, lifted from inline bits (<b>, <a>) to their block; null on the bare page. */
function blockAt(x, y) {
  let el = document.elementFromPoint(x, y);
  if (el && el.closest(UI_SELECTOR)) return null;
  while (el && el !== document.body && getComputedStyle(el).display === 'inline') el = el.parentElement;
  return !el || el === document.body || el === document.documentElement ? null : el;
}

/** Top-left corner of an element in page coordinates (scroll included). */
function pageCorner(el) {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + window.scrollX, y: rect.top + window.scrollY };
}
