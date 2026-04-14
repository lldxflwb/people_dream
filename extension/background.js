const API_URL = "http://127.0.0.1:4017/api/capture";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "capture-page") {
    return false;
  }

  fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message.payload)
  })
    .then(async (response) => {
      const data = await response.json();
      sendResponse({
        ok: response.ok,
        data,
        tabId: sender.tab ? sender.tab.id : null
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message
      });
    });

  return true;
});
