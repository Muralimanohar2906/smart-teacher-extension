const serverUrlEl = document.getElementById('serverUrl');
const numQEl = document.getElementById('numQ');
const diffEl = document.getElementById('difficulty');
const statusEl = document.getElementById('status');

(async () => {
  // restore last server url
  const { serverUrl='http://127.0.0.1:8000' } = await chrome.storage.sync.get(['serverUrl']);
  serverUrlEl.value = serverUrl;
})();

serverUrlEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ serverUrl: serverUrlEl.value.trim() });
});

document.getElementById('genBtn').addEventListener('click', async () => {
  statusEl.textContent = 'Requesting generation...';
  await chrome.storage.sync.set({
    serverUrl: serverUrlEl.value.trim(),
    numQ: Number(numQEl.value),
    difficulty: diffEl.value
  });
  chrome.runtime.sendMessage({ type: 'ST_GENERATE' }, () => {
    statusEl.textContent = 'Working… watch the page overlay.';
  });
});
