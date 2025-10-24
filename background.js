// background.js (service worker)
chrome.runtime.onInstalled.addListener(() => {
  console.log('Smart Teacher installed');
});

// Simple listener for debugging/log messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'LOG') {
    console.log('FROM CONTENT:', message.payload);
  }
});
