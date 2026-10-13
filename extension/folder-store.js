// The chosen notes folder: a directory handle in the extension's IndexedDB, shared by the
// side panel (which picks it) and the background worker (which writes into it).

const DB = 'decision-notes';
const STORE = 'folder';
const KEY = 'current';

/** The chosen folder as { handle, version }, or null if none was chosen yet. */
export async function getFolder() {
  return (await run('readonly', (store) => store.get(KEY))) ?? null;
}

/**
 * Remember a newly picked folder. The version changes with every pick, so pages still holding
 * notes from the old folder are told to reload instead of writing them into the new one.
 */
export async function setFolder(handle) {
  const record = { handle, version: Date.now() };
  await run('readwrite', (store) => store.put(record, KEY));
  return record;
}

async function run(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
