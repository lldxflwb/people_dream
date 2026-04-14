importScripts("shared.js");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "capture-page") {
    return false;
  }

  getConfiguredBaseUrl()
    .then((baseUrl) =>
      fetch(`${baseUrl}/api/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(message.payload)
      })
    )
    .then(async (response) => {
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }

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
