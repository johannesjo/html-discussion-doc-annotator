import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveDoc, renderNotes, parseNotes, injectClient, createHandler } from '../serve.mjs';

const ROOT = path.resolve('/srv/planning');

test('resolveDoc accepts .html files inside the root', () => {
  assert.equal(resolveDoc(ROOT, 'plan.html'), path.join(ROOT, 'plan.html'));
  assert.equal(resolveDoc(ROOT, '/sub/plan.html'), path.join(ROOT, 'sub', 'plan.html'));
  assert.equal(resolveDoc(ROOT, '/Weekly%20Plan.HTML'), path.join(ROOT, 'Weekly Plan.HTML'));
});

test('resolveDoc rejects paths outside the root, other types and bad escapes', () => {
  for (const name of [
    '../secret.html',
    '/../secret.html',
    '%2e%2e%2fsecret.html',
    '..%2Fsecret.html',
    'sub/../../secret.html',
    'plan.notes.md',
    'plan.html.js',
    'plan%00.html',
    '%E0%A4%A.html',
    '',
  ]) {
    assert.equal(resolveDoc(ROOT, name), null, name);
  }
});

test('renderNotes writes the documented format and leaves out empty notes', () => {
  const md = renderNotes(
    'weekly-insights-decisions.html',
    [
      { id: 'where-are-shared-reports-stored', heading: 'Where are shared reports stored?', text: 'Backend ok, needs SiKon entry.' },
      { id: 'empty', heading: 'Empty', text: '  \n ' },
    ],
    { savedAt: new Date(2026, 9, 13, 18, 2) },
  );
  assert.equal(
    md,
    [
      '# Notes: weekly-insights-decisions.html',
      '',
      '_Last saved 2026-10-13 18:02_',
      '',
      '## Where are shared reports stored?',
      '<!-- note:where-are-shared-reports-stored -->',
      '',
      'Backend ok, needs SiKon entry.',
      '',
    ].join('\n'),
  );
});

test('parseNotes reads back what renderNotes wrote, including Markdown headings in the text', () => {
  const notes = [
    { id: 'a', heading: 'First | row', text: 'one\n\n## not a note, just a heading\n- item' },
    { id: 'b-2', heading: 'Was gut lief', text: 'two' },
  ];
  assert.deepEqual(parseNotes(renderNotes('x.html', notes)), notes);
});

test('parseNotes tolerates hand edits: CRLF, extra spaces, missing heading', () => {
  const md = '# Notes\r\n\r\n## Edited by hand  \r\n<!--  note:a  -->\r\nfixed text\r\n\r\n<!-- note:b -->\r\nno heading\r\n';
  assert.deepEqual(parseNotes(md), [
    { id: 'a', heading: 'Edited by hand', text: 'fixed text' },
    { id: 'b', heading: '', text: 'no heading' },
  ]);
});

test('injectClient adds the script before the last </body>, or at the end', () => {
  assert.equal(
    injectClient('<p>x</p></BODY></html>'),
    '<p>x</p><script src="/__notes/client.js"></script></BODY></html>',
  );
  assert.equal(injectClient('<p>x</p>'), '<p>x</p><script src="/__notes/client.js"></script>');
});

// End to end over a real port (127.0.0.1, random port), against a temp folder.
test('server: serve doc, read and write notes, refuse what it must', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'decision-notes-'));
  await mkdir(path.join(root, 'sub'));
  const docHtml = '<html><body><h2>Q</h2></body></html>';
  await writeFile(path.join(root, 'sub', 'plan.html'), docHtml);
  await writeFile(path.join(root, 'secret.txt'), 'no');
  await writeFile(path.join(root, 'Q#1?.html'), '<p>odd name</p>');
  for (const hidden of ['.git', 'node_modules']) {
    await mkdir(path.join(root, hidden));
    await writeFile(path.join(root, hidden, 'skip.html'), '');
  }
  const call = await serve(t, root);
  const data = '/__notes/data?doc=' + encodeURIComponent('/sub/plan.html');

  const index = await call('GET', '/');
  assert.match(index.body, /href="\/sub\/plan.html"/);
  assert.doesNotMatch(index.body, /skip\.html/);
  const odd = index.body.match(/href="([^"]*odd[^"]*|\/Q[^"]*)"/)[1];
  assert.equal((await call('GET', odd)).status, 200, odd);

  const doc = await call('GET', '/sub/plan.html');
  assert.equal(doc.status, 200);
  assert.match(doc.body, /<h2>Q<\/h2><script src="\/__notes\/client.js"><\/script><\/body>/);
  assert.equal(await readFile(path.join(root, 'sub', 'plan.html'), 'utf8'), docHtml);

  assert.equal((await call('GET', '/__notes/client.js')).status, 200);
  assert.deepEqual(JSON.parse((await call('GET', data)).body), { notes: [] });

  const notes = [{ id: 'q', heading: 'Q', text: 'Agreed.' }];
  assert.equal((await call('PUT', data, JSON.stringify({ notes }))).status, 200);
  assert.match(await readFile(path.join(root, 'sub', 'plan.notes.md'), 'utf8'), /^# Notes: plan.html\n/);
  assert.deepEqual(JSON.parse((await call('GET', data)).body), { notes });

  assert.equal((await call('PUT', data, '{nope')).status, 400);
  assert.equal((await call('PUT', data, JSON.stringify({ notes: [{ id: 'x -->', heading: '', text: '' }] }))).status, 400);
  assert.equal((await call('PUT', '/__notes/data?doc=missing.html', JSON.stringify({ notes }))).status, 404);
  assert.equal((await call('GET', '/__notes/data?doc=..%2Fx.html')).status, 404);
  assert.equal((await call('GET', '/secret.txt')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/etc/passwd.html')).status, 404);
  assert.equal((await call('GET', '/sub/plan.html', undefined, 'evil.example:4321')).status, 403);
  assert.equal((await call('GET', '/sub/plan.html', undefined, 'localhost:abc')).status, 403);
  assert.equal((await call('PUT', data, 'x'.repeat(5 * 1024 * 1024 + 1))).status, 413);
});

// Overlapping saves (two tabs) must leave one whole file, never a mix of both.
test('server: concurrent saves to one doc leave one complete notes file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'decision-notes-'));
  await writeFile(path.join(root, 'plan.html'), '<h2>Q</h2>');
  const call = await serve(t, root);
  const texts = Array.from({ length: 20 }, (_, i) => String(i % 10).repeat(200_000 + i));
  const bodies = texts.map((text) => JSON.stringify({ notes: [{ id: 'q', heading: 'Q', text }] }));
  const results = await Promise.all(bodies.map((body) => call('PUT', '/__notes/data?doc=plan.html', body)));
  assert.deepEqual(results.map((r) => r.status), texts.map(() => 200));
  const [saved] = parseNotes(await readFile(path.join(root, 'plan.notes.md'), 'utf8'));
  assert.ok(texts.includes(saved.text), 'file is exactly one of the saves');
});

async function serve(t, root) {
  const server = createServer(createHandler(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return (method, url, body, host) => httpCall({ port: server.address().port, method, url, body, host });
}

function httpCall({ port, method, url, body, host }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host ?? `127.0.0.1:${port}` };
    const req = request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('server: text written by hand above the first note survives a save', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'decision-notes-'));
  await writeFile(path.join(root, 'plan.html'), '<h2>Q</h2>');
  const handWritten = [
    '# Notes: plan.html',
    '',
    '_Last saved 2026-10-13 18:02_',
    '',
    'Summary: we agreed on option B.',
    '',
    '- follow-up with Anna',
    '',
    '## Q',
    '<!-- note:q -->',
    '',
    'old',
    '',
  ].join('\n');
  await writeFile(path.join(root, 'plan.notes.md'), handWritten);
  const call = await serve(t, root);
  const notes = [{ id: 'q', heading: 'Q', text: 'new' }];
  assert.equal((await call('PUT', '/__notes/data?doc=plan.html', JSON.stringify({ notes }))).status, 200);
  const md = await readFile(path.join(root, 'plan.notes.md'), 'utf8');
  assert.match(md, /^# Notes: plan.html\n\n_Last saved [^_]+_\n\nSummary: we agreed on option B.\n\n- follow-up with Anna\n\n## Q\n<!-- note:q -->\n\nnew\n$/);
  assert.deepEqual(parseNotes(md), notes);
});

// launchd agents and shell aliases often start the server through a symlinked path
test('server starts when serve.mjs is run through a symlink', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'decision-notes-link-'));
  const link = path.join(dir, 'serve.mjs');
  await symlink(fileURLToPath(new URL('../serve.mjs', import.meta.url)), link);
  const child = spawn(process.execPath, [link, dir], { env: { ...process.env, PORT: '0' } });
  t.after(() => child.kill());
  const output = await new Promise((resolve) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      if (text.includes('Decision notes on')) resolve(text);
    });
    child.on('exit', () => resolve(text));
  });
  assert.match(output, /Decision notes on http:\/\/localhost:/);
});

test('server refuses to start when the docs folder does not exist', async () => {
  const missing = path.join(tmpdir(), 'decision-notes-missing-' + process.pid);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../serve.mjs', import.meta.url)), missing], {
    env: { ...process.env, PORT: '0' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill(), 3000); // a server that started anyway would never exit
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  assert.equal(code, 1, output);
  assert.match(output, /Docs folder not found: .*decision-notes-missing-/);
});
