async function getBaseUrl() {
  return getConfiguredBaseUrl();
}

async function getState(baseUrl) {
  const response = await fetch(`${baseUrl}/api/state`);
  if (!response.ok) {
    throw new Error("服务未启动或地址不可达");
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
    const baseUrl = await getBaseUrl();
    document.getElementById("baseUrlInput").value = baseUrl;
    const state = await getState(baseUrl);
    document.getElementById("status").textContent = state.settings.paused
      ? `当前已暂停采集 (${baseUrl})`
      : `采集中，已跟踪 ${state.report.stats.trackedPages} 条资源 (${baseUrl})`;
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
  const baseUrl = await getBaseUrl();
  const state = await getState(baseUrl);
  await postJson(`${baseUrl}/api/pause`, { paused: !state.settings.paused });
  await refreshStatus();
});

document.getElementById("openButton").addEventListener("click", async () => {
  const baseUrl = await getBaseUrl();
  await chrome.tabs.create({ url: baseUrl });
});

document.getElementById("saveAddressButton").addEventListener("click", async () => {
  try {
    const value = document.getElementById("baseUrlInput").value;
    await setConfiguredBaseUrl(value);
    await refreshStatus();
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
});

refreshStatus();
