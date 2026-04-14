const BASE_URL = "http://127.0.0.1:4017";

async function getState() {
  const response = await fetch(`${BASE_URL}/api/state`);
  if (!response.ok) {
    throw new Error("localhost 服务未启动");
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error("请求失败");
  }
  return response.json();
}

async function refreshStatus() {
  try {
    const state = await getState();
    document.getElementById("status").textContent = state.settings.paused
      ? "当前已暂停采集"
      : `采集中，已跟踪 ${state.report.stats.trackedPages} 条资源`;
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
}

document.getElementById("captureButton").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return;
  }
  await chrome.tabs.sendMessage(tab.id, { type: "force-capture" });
  await refreshStatus();
});

document.getElementById("pauseButton").addEventListener("click", async () => {
  const state = await getState();
  await postJson(`${BASE_URL}/api/pause`, { paused: !state.settings.paused });
  await refreshStatus();
});

document.getElementById("openButton").addEventListener("click", async () => {
  await chrome.tabs.create({ url: BASE_URL });
});

refreshStatus();
