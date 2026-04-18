import browser from "webextension-polyfill";

import { getConfiguredBaseUrl } from "./config";
import {
  MESSAGE_TYPE_CAPTURE_PAGE,
  type CapturePageMessage,
  type RuntimeMessage
} from "./types";

browser.runtime.onMessage.addListener(
  async (message: RuntimeMessage, sender: browser.runtime.MessageSender) => {
    if (message.type !== MESSAGE_TYPE_CAPTURE_PAGE) {
      return undefined;
    }

    const captureMessage = message as CapturePageMessage;

    try {
      const baseUrl = await getConfiguredBaseUrl();
      const response = await fetch(`${baseUrl}/api/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(captureMessage.payload)
      });

      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      return {
        data,
        ok: response.ok,
        tabId: sender.tab?.id ?? null
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Unknown error",
        ok: false
      };
    }
  }
);
