import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docKey, notesFileName, renderNotes, parseNotes, parsePreamble, parseDocUrl, validNotes } from '../extension/format.js';

const URL_ = 'file:///home/me/planning/weekly-insights-decisions.html';

test('docKey drops the #fragment, and for file:// also the ?query', () => {
  assert.equal(docKey('file:///a/plan.html?x=1#top'), 'file:///a/plan.html');
  assert.equal(docKey('https://wiki.example/page?id=7#s2'), 'https://wiki.example/page?id=7');
});

test('notesFileName: doc name for files, host and path for web pages, no characters files cannot have', () => {
  assert.equal(notesFileName(URL_), 'weekly-insights-decisions.notes.md');
  assert.equal(notesFileName('file:///a/Weekly%20Plan.HTM'), 'Weekly Plan.notes.md');
  assert.equal(notesFileName('https://wiki.example/spaces/x/page?id=7'), 'wiki.example - spaces - x - page - id=7.notes.md');
  assert.equal(notesFileName('https://wiki.example/'), 'wiki.example.notes.md');
  assert.equal(notesFileName('https://wiki.example/a:b%3F*'), 'wiki.example - a-b-.notes.md');
});

test('renderNotes writes the documented format: positions in the marker, empty notes left out', () => {
  const md = renderNotes(
    URL_,
    [
      { id: 'n-1', heading: 'Where are shared reports stored?', text: 'Backend ok.', place: { at: 'h2:1', dx: 12, dy: -4 } },
      { id: 'n-2', heading: '', text: 'Free spot.', place: { dx: 300, dy: 40, min: true } },
      { id: 'n-3', heading: 'Empty', text: '  \n ', place: { dx: 0, dy: 0 } },
    ],
    { savedAt: new Date(2026, 9, 13, 18, 2) },
  );
  assert.equal(
    md,
    [
      '# Notes: weekly-insights-decisions.html',
      `<!-- doc: ${URL_} -->`,
      '',
      '_Last saved 2026-10-13 18:02_',
      '',
      '## Where are shared reports stored?',
      '<!-- note:n-1 {"at":"h2:1","dx":12,"dy":-4} -->',
      '',
      'Backend ok.',
      '',
      '## On the page',
      '<!-- note:n-2 {"dx":300,"dy":40,"min":true} -->',
      '',
      'Free spot.',
      '',
    ].join('\n'),
  );
  assert.equal(parseDocUrl(md), URL_);
});

test('parseNotes reads back what renderNotes wrote, including Markdown headings in the text', () => {
  const notes = [
    { id: 'a', heading: 'First | row', text: 'one\n\n## not a note, just a heading\n- item', place: { at: 'table:1/tbody:1/tr:2', dx: 0, dy: 20 } },
    { id: 'b-2', heading: 'Was gut lief', text: 'two', place: { at: 'h2:3', dx: 5, dy: 5, min: true } },
  ];
  assert.deepEqual(parseNotes(renderNotes(URL_, notes)), notes);
});

test('parseNotes tolerates hand edits and the old format: CRLF, no heading, no or broken position', () => {
  const md = '# Notes\r\n\r\n## Edited by hand  \r\n<!--  note:a  -->\r\nfixed text\r\n\r\n<!-- note:b {"dx": oops} -->\r\nno heading\r\n';
  assert.deepEqual(parseNotes(md), [
    { id: 'a', heading: 'Edited by hand', text: 'fixed text', place: null },
    { id: 'b', heading: '', text: 'no heading', place: null },
  ]);
  assert.equal(parseDocUrl(md), null);
});

test('parsePreamble keeps hand-written text, drops the generated lines', () => {
  const md = renderNotes(URL_, [{ id: 'q', heading: 'Q', text: 'x', place: { dx: 1, dy: 1 } }], {
    preamble: 'Summary: option B.\n\n- follow up',
  });
  assert.equal(parsePreamble(md), 'Summary: option B.\n\n- follow up');
});

test('validNotes accepts what pages send and refuses bad IDs, positions and paths', () => {
  const ok = [{ id: 'n-1', heading: 'H', text: 't', place: { at: 'main:1/p:2', dx: 1.6, dy: 2 }, extra: 1 }];
  assert.deepEqual(validNotes(ok), [{ id: 'n-1', heading: 'H', text: 't', place: { at: 'main:1/p:2', dx: 2, dy: 2 } }]);
  assert.deepEqual(validNotes([{ id: 'lost', heading: 'H', text: 't', place: null }])[0].place, null);
  for (const bad of [
    null,
    [{ id: 'x -->', heading: '', text: '', place: null }],
    [{ id: 'a', heading: 1, text: '', place: null }],
    [{ id: 'a', heading: '', text: '', place: { dx: 'x', dy: 1 } }],
    [{ id: 'a', heading: '', text: '', place: { at: 'p:1 --> <script>', dx: 1, dy: 1 } }],
  ]) {
    assert.equal(validNotes(bad), null, JSON.stringify(bad));
  }
});

test('a line break encoded in the address cannot add lines to the file', () => {
  const md = renderNotes('http://wiki/p%0A%3C!--%20note:evil%20--%3E', [{ id: 'a', heading: 'H', text: 't', place: null }]);
  assert.deepEqual(parseNotes(md).map((n) => n.id), ['a']);
});
