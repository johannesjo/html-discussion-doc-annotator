// Background worker: reads and writes the notes files for the pages. Holds no state of its own;
// Chrome may stop it at any time, so the folder comes from IndexedDB on every message.
import { getFolder } from './folder-store.js';
import { coded, loadNotes, saveNotes, serial, usableFolder } from './notes-io.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('Decision notes: side panel setup failed', err));

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // only pages talk to the worker; the side panel uses the folder store directly
  if (!sender.tab || !sender.url) return false;
  handle(message, sender.url).then(
    (result) => reply({ ok: true, ...result }),
    (err) => {
      if (!err.code) console.error('Decision notes:', err);
      reply({ ok: false, error: err.code ?? 'failed', message: String(err.message ?? err) });
    },
  );
  return true; // the reply comes asynchronously
});

async function handle(message, url) {
  const record = await getFolder();
  if (message.type === 'load') {
    const dir = await usableFolder(record);
    return { notes: await loadNotes(dir, url), folder: dir.name, version: record.version };
  }
  if (message.type === 'save') {
    const dir = await usableFolder(record, message.version);
    return { file: await serial(() => saveNotes(dir, url, message.notes)) };
  }
  throw coded('bad-message', 'Unknown message type ' + message.type);
}
