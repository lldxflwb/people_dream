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

async function getPageStatus(baseUrl, url) {
  const requestUrl = new URL(`${baseUrl}/api/page-status`);
  requestUrl.searchParams.set("url", url);

  const response = await fetch(requestUrl.toString());
  if (!response.ok) {
    throw new Error("当前页面状态读取失败");
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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isCapturableUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function renderPageStatus(status, tab) {
  const summary = document.getElementById("pageStatusSummary");
  const urlNode = document.getElementById("pageStatusUrl");
  const meta = document.getElementById("pageStatusMeta");

  if (!tab || !isCapturableUrl(tab.url)) {
    summary.textContent = "当前标签页不是可采集的网页。";
    urlNode.textContent = tab && tab.url ? tab.url : "";
    meta.textContent = "";
    return;
  }

  urlNode.innerHTML = `<code>${status.normalizedUrl || tab.url}</code>`;

  if (status.blacklisted && status.rule) {
    summary.textContent = `当前页命中黑名单，不会进入采集。`;
    meta.textContent = `${status.rule.kind} / ${status.rule.mode} / ${status.rule.pattern}`;
    return;
  }

  if (status.exists && status.resource) {
    summary.textContent = "当前页已经采集过。";
    meta.textContent =
      `最近一次：${status.resource.lastSeenAt}｜访问 ${status.resource.visitCount} 次｜版本 ${status.resource.versionCount} 个`;
    return;
  }

  summary.textContent = "当前页还没有采集记录。";
  meta.textContent = "保持页面停留，或点击“立即捕获当前页”。";
}

async function refreshPageStatus(baseUrl) {
  const tab = await getActiveTab();
  if (!tab || !isCapturableUrl(tab.url)) {
    renderPageStatus(null, tab);
    return;
  }

  try {
    const status = await getPageStatus(baseUrl, tab.url);
    renderPageStatus(status, tab);
  } catch (error) {
    document.getElementById("pageStatusSummary").textContent = error.message;
    document.getElementById("pageStatusUrl").textContent = tab.url || "";
    document.getElementById("pageStatusMeta").textContent = "";
  }
}

async function refreshStatus() {
  try {
    const baseUrl = await getBaseUrl();
    document.getElementById("baseUrlInput").value = baseUrl;
    const state = await getState(baseUrl);
    document.getElementById("status").textContent = state.settings.paused
      ? `当前已暂停采集 (${baseUrl})`
      : `采集中，已跟踪 ${state.report.stats.trackedPages} 条资源 (${baseUrl})`;
    await refreshPageStatus(baseUrl);
  } catch (error) {
    document.getElementById("status").textContent = error.message;
    document.getElementById("pageStatusSummary").textContent = "当前页面状态不可用。";
    document.getElementById("pageStatusUrl").textContent = "";
    document.getElementById("pageStatusMeta").textContent = "";
  }
}

document.getElementById("captureButton").addEventListener("click", async () => {
  const tab = await getActiveTab();
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
