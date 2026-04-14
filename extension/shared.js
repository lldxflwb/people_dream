const DEFAULT_BASE_URL = "http://127.0.0.1:9095";
const STORAGE_KEY = "peopleDreamBaseUrl";

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }

  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }

  const parsed = new URL(normalized);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function getConfiguredBaseUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(normalizeBaseUrl(result[STORAGE_KEY]));
    });
  });
}

function setConfiguredBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: normalized }, () => resolve(normalized));
  });
}
