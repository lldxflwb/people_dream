import browser from "webextension-polyfill";

const DEFAULT_BASE_URL = "http://127.0.0.1:9095";
const STORAGE_KEY = "peopleDreamBaseUrl";

export function normalizeBaseUrl(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
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

export async function getConfiguredBaseUrl(): Promise<string> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return normalizeBaseUrl(result[STORAGE_KEY] as string | undefined);
}

export async function setConfiguredBaseUrl(value: string): Promise<string> {
  const normalized = normalizeBaseUrl(value);
  await browser.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}
