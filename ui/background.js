// Background: routes popup actions to content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ST_GENERATE") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: "ST_GENERATE" });
    });
    sendResponse({ ok: true });
  }
});
