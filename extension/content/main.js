// Wiring: toolbar (+ Note, save status), the N key, the side panel's "start here" and relayout.
// Until a page has notes or the side panel starts a session on it, nothing is shown and N is free.
'use strict';

const STYLE = `
.dn-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483640;font:13px/1.4 sans-serif;color:#222}
.dn-card{position:absolute;width:240px;background:#fffaf3;border:1px solid #f28c28;border-left-width:4px;
  border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.dn-bar{display:flex;align-items:center;gap:2px;padding:2px 4px;background:#fde3c8;cursor:move;user-select:none}
.dn-title{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:bold;font-size:12px}
.dn-bar button{border:0;background:none;color:#555;cursor:pointer;font:bold 14px/1 sans-serif;padding:2px 5px}
.dn-text{display:block;box-sizing:border-box;width:100%;min-height:3.6em;padding:.4em .5em;border:0;
  background:transparent;color:inherit;font:inherit;resize:vertical}
.dn-card.dn-min .dn-text{display:none}
.dn-dragging{pointer-events:none;opacity:.85}
.dn-tray{position:fixed;right:12px;top:12px;display:flex;flex-direction:column;gap:6px;max-height:80vh;overflow:auto}
.dn-tray:empty{display:none}
.dn-card.dn-lost{position:static;border-color:#d33}
.dn-target{position:fixed;pointer-events:none;outline:2px dashed #f28c28;outline-offset:2px}
.dn-toolbar{position:fixed;right:12px;bottom:12px;display:flex;gap:6px;align-items:center;font-size:12px}
.dn-add{border:0;border-radius:999px;padding:4px 10px;background:#f28c28;color:#fff;font:bold 12px sans-serif;cursor:pointer}
.dn-status{padding:3px 10px;border-radius:999px;background:#e8e8e8;color:#333}
.dn-status[data-state=error]{background:#d33;color:#fff}
html.dn-placing,html.dn-placing *{cursor:crosshair!important}`;

let toolbar = null;
let pointer = null; // last mouse position in the viewport, for N
let placing = false; // "+ Note" was clicked: the next click on the page places the card

function activate() {
  if (dn.active) return;
  dn.active = true;
  toolbar = make('div', 'dn-toolbar');
  const add = make('button', 'dn-add', '+ Note');
  add.type = 'button';
  add.title = 'Click, then click where the note goes. Or press N with the mouse over the spot.';
  add.addEventListener('click', () => setPlacing(!placing));
  toolbar.append(add, make('span', 'dn-status'));
  ensureLayer().append(toolbar);
  renderStatus();
  renderCards();
}

function renderStatus() {
  if (!toolbar) return;
  const pill = toolbar.querySelector('.dn-status');
  pill.dataset.state = dn.status.kind;
  pill.textContent = placing ? 'Click where the note goes (Esc cancels)' : dn.status.text;
}

function setPlacing(on) {
  placing = on;
  document.documentElement.classList.toggle('dn-placing', on);
  renderStatus();
}

function isTyping(el) {
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

function onKey(event) {
  if (event.key === 'Escape' && placing) return setPlacing(false);
  if (event.key !== 'n' && event.key !== 'N') return;
  if (!dn.active || !pointer || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
  event.preventDefault();
  addNoteAt(pointer.x, pointer.y);
}

// capture phase: a click meant to place a note must not also follow a link or press a button
function onPlacingClick(event) {
  if (!placing || event.target.closest(UI_SELECTOR)) return;
  event.preventDefault();
  event.stopPropagation();
  setPlacing(false);
  addNoteAt(event.clientX, event.clientY);
}

function relayoutSoon() {
  if (dn.active) requestAnimationFrame(layoutCards);
}

function init() {
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onPlacingClick, true);
  document.addEventListener('mousemove', (e) => (pointer = { x: e.clientX, y: e.clientY }), { passive: true });
  window.addEventListener('resize', relayoutSoon);
  // images and fonts arriving late move elements; cards follow
  if (window.ResizeObserver) new ResizeObserver(relayoutSoon).observe(document.body);
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'activate') return;
    activate();
    load();
  });
  load();
}

init();
