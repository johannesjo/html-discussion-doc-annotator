// Side panel: picks the notes folder (the system folder dialog), renews Chrome's permission for it,
// and turns the note layer on for whichever page is shown while the panel is open.
import { getFolder, setFolder } from './folder-store.js';

const $ = (id) => document.getElementById(id);
const ACCESS_TEXT = {
  granted: 'Notes are saved there while you type.',
  prompt: 'Chrome needs your OK to write there again.',
  denied: 'Chrome refused access. Choose the folder again.',
  none: 'Choose a folder to start.',
};

async function refresh() {
  const record = await getFolder();
  const access = record ? await record.handle.queryPermission({ mode: 'readwrite' }) : 'none';
  $('folder').textContent = record ? record.handle.name : 'none chosen yet';
  $('access').textContent = ACCESS_TEXT[access];
  $('continue').hidden = access !== 'prompt';
  if (record) $('continue').textContent = `Continue in “${record.handle.name}”`;
}

async function startOnActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'activate' });
    $('page').textContent = 'Notes are on for this page.';
  } catch (err) {
    console.warn('Decision notes: page did not answer', err);
    $('page').textContent =
      'Notes cannot run on this page. Reload it; for local files switch on "Allow access to file URLs" in the extension details.';
  }
}

async function chooseFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'decision-notes', mode: 'readwrite' });
  } catch (err) {
    if (err.name === 'AbortError') return; // dialog closed without a choice
    throw err;
  }
  await setFolder(handle);
  await refresh();
  await startOnActivePage();
}

async function continueInFolder() {
  const record = await getFolder();
  if ((await record.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return refresh();
  await refresh();
  await startOnActivePage();
}

function showError(err) {
  console.error('Decision notes:', err);
  $('access').textContent = 'Something went wrong: ' + (err.message || err);
}

$('choose').addEventListener('click', () => chooseFolder().catch(showError));
$('continue').addEventListener('click', () => continueInFolder().catch(showError));
chrome.tabs.onActivated.addListener(() => startOnActivePage().catch(showError));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.active && change.status === 'complete') startOnActivePage().catch(showError);
});
refresh()
  .then(startOnActivePage)
  .catch(showError);
