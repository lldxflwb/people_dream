import browser from "webextension-polyfill";

import { getConfiguredBaseUrl, setConfiguredBaseUrl } from "./config";
import { MESSAGE_TYPE_FORCE_CAPTURE, type ExtensionStateResponse, type ForceCaptureMessage, type PageStatusResponse } from "./types";

const statusNode = getRequiredElement("status");
const baseUrlInput = getRequiredInput("baseUrlInput");
const pageStatusSummaryNode = getRequiredElement("pageStatusSummary");
const pageStatusUrlNode = getRequiredElement("pageStatusUrl");
const pageStatusMetaNode = getRequiredElement("pageStatusMeta");
const captureButton = getRequiredButton("captureButton");
const pauseButton = getRequiredButton("pauseButton");
const openButton = getRequiredButton("openButton");
const saveAddressButton = getRequiredButton("saveAddressButton");

captureButton.addEventListener("click", () => {
  void handleCapture();
});

pauseButton.addEventListener("click", () => {
  void handlePauseToggle();
});

openButton.addEventListener("click", () => {
  void handleOpen();
});

saveAddressButton.addEventListener("click", () => {
  void handleSaveAddress();
});

void refreshStatus();

async function handleCapture(): Promise<void> {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }

  await browser.tabs.sendMessage(tab.id, {
    type: MESSAGE_TYPE_FORCE_CAPTURE
  } satisfies ForceCaptureMessage);

  await refreshStatus();
}

async function handlePauseToggle(): Promise<void> {
  const baseUrl = await getBaseUrl();
  const state = await getState(baseUrl);
  await postJson(`${baseUrl}/api/pause`, { paused: !state.settings.paused });
  await refreshStatus();
}

async function handleOpen(): Promise<void> {
  const baseUrl = await getBaseUrl();
  await browser.tabs.create({ url: baseUrl });
}

async function handleSaveAddress(): Promise<void> {
  try {
    await setConfiguredBaseUrl(baseUrlInput.value);
    await refreshStatus();
  } catch (error) {
    statusNode.textContent = error instanceof Error ? error.message : "保存地址失败";
  }
}

async function getBaseUrl(): Promise<string> {
  return getConfiguredBaseUrl();
}

async function getState(baseUrl: string): Promise<ExtensionStateResponse> {
  const response = await fetch(`${baseUrl}/api/state`);
  if (!response.ok) {
    throw new Error("服务未启动或地址不可达");
  }
  return response.json() as Promise<ExtensionStateResponse>;
}

async function getPageStatus(baseUrl: string, url: string): Promise<PageStatusResponse> {
  const requestUrl = new URL(`${baseUrl}/api/page-status`);
  requestUrl.searchParams.set("url", url);

  const response = await fetch(requestUrl.toString());
  if (!response.ok) {
    throw new Error("当前页面状态读取失败");
  }
  return response.json() as Promise<PageStatusResponse>;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
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

  return response.json() as Promise<unknown>;
}

async function getActiveTab(): Promise<browser.tabs.Tab | null> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function isCapturableUrl(url: string | undefined): boolean {
  return /^https?:\/\//i.test(String(url ?? ""));
}

function renderPageStatus(status: PageStatusResponse | null, tab: browser.tabs.Tab | null): void {
  const tabUrl = tab?.url;

  if (!tab || !tabUrl || !isCapturableUrl(tabUrl)) {
    pageStatusSummaryNode.textContent = "当前标签页不是可采集的网页。";
    pageStatusUrlNode.textContent = tabUrl ?? "";
    pageStatusMetaNode.textContent = "";
    return;
  }

  pageStatusUrlNode.replaceChildren(createCodeNode(status?.normalizedUrl ?? tabUrl));

  if (status?.blacklisted && status.rule) {
    pageStatusSummaryNode.textContent = "当前页命中黑名单，不会进入采集。";
    pageStatusMetaNode.textContent = `${status.rule.kind} / ${status.rule.mode} / ${status.rule.pattern}`;
    return;
  }

  if (status?.exists && status.resource) {
    pageStatusSummaryNode.textContent = "当前页已经采集过。";
    pageStatusMetaNode.textContent =
      `最近一次：${status.resource.lastSeenAt}｜访问 ${status.resource.visitCount} 次｜版本 ${status.resource.versionCount} 个`;
    return;
  }

  pageStatusSummaryNode.textContent = "当前页还没有采集记录。";
  pageStatusMetaNode.textContent = "保持页面停留，或点击“立即捕获当前页”。";
}

async function refreshPageStatus(baseUrl: string): Promise<void> {
  const tab = await getActiveTab();
  const tabUrl = tab?.url;

  if (!tab || !tabUrl || !isCapturableUrl(tabUrl)) {
    renderPageStatus(null, tab);
    return;
  }

  try {
    const status = await getPageStatus(baseUrl, tabUrl);
    renderPageStatus(status, tab);
  } catch (error) {
    pageStatusSummaryNode.textContent = error instanceof Error ? error.message : "当前页面状态读取失败";
    pageStatusUrlNode.textContent = tabUrl;
    pageStatusMetaNode.textContent = "";
  }
}

async function refreshStatus(): Promise<void> {
  try {
    const baseUrl = await getBaseUrl();
    baseUrlInput.value = baseUrl;

    const state = await getState(baseUrl);
    statusNode.textContent = state.settings.paused
      ? `当前已暂停采集 (${baseUrl})`
      : `采集中，已跟踪 ${state.report.stats.trackedPages} 条资源 (${baseUrl})`;

    await refreshPageStatus(baseUrl);
  } catch (error) {
    statusNode.textContent = error instanceof Error ? error.message : "状态读取失败";
    pageStatusSummaryNode.textContent = "当前页面状态不可用。";
    pageStatusUrlNode.textContent = "";
    pageStatusMetaNode.textContent = "";
  }
}

function createCodeNode(content: string): HTMLElement {
  const code = document.createElement("code");
  code.textContent = content;
  return code;
}

function getRequiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

function getRequiredInput(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing input: ${id}`);
  }
  return element;
}

function getRequiredButton(id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${id}`);
  }
  return element;
}
