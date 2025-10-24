// popup/popup.js
document.getElementById('inject').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['libs/xmldom.min.js','libs/compromise.min.js','content_script.js']
    });
    document.getElementById('status').textContent = 'Injected! Switch to the YouTube tab.';
  } catch (e) {
    document.getElementById('status').textContent = 'Failed to inject: ' + (e.message || e);
  }
});
