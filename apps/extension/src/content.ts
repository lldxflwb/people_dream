import browser from "webextension-polyfill";

import { getConfiguredBaseUrl } from "./config";
import {
  MESSAGE_TYPE_CAPTURE_PAGE,
  MESSAGE_TYPE_FORCE_CAPTURE,
  type CapturePayload,
  type CaptureReason,
  type ForceCaptureMessage,
  type RuntimeMessage
} from "./types";

interface CaptureState {
  enteredAt: number;
  maxScrollDepth: number;
  sent: boolean;
}

void initialize();

async function initialize(): Promise<void> {
  try {
    const baseUrl = await getConfiguredBaseUrl();
    if (location.origin === new URL(baseUrl).origin) {
      return;
    }
  } catch {
    // Fall back to capturing if config cannot be read.
  }

  startCapture();
}

function startCapture(): void {
  const state: CaptureState = {
    enteredAt: Date.now(),
    maxScrollDepth: 0,
    sent: false
  };

  const updateScrollDepth = (): void => {
    const maxScrollable = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    const currentDepth = Math.min(100, Math.round((window.scrollY / maxScrollable) * 100));
    state.maxScrollDepth = Math.max(state.maxScrollDepth, currentDepth);
  };

  const capturePage = async (reason: CaptureReason): Promise<void> => {
    if (state.sent && reason !== "manual") {
      return;
    }

    const dwellMs = Date.now() - state.enteredAt;
    if (dwellMs < 3500 && reason !== "manual") {
      return;
    }

    updateScrollDepth();
    const textContent = readText();
    if (!textContent) {
      return;
    }

    state.sent = true;

    const payload: CapturePayload = {
      capturedAt: new Date().toISOString(),
      dwellMs,
      excerpt: textContent.slice(0, 240),
      pageSignals: detectPageSignals(),
      reason,
      scrollDepth: state.maxScrollDepth,
      textContent,
      title: document.title,
      url: location.href
    };

    try {
      await browser.runtime.sendMessage({
        payload,
        type: MESSAGE_TYPE_CAPTURE_PAGE
      });
    } catch {
      // Background failures should not break the page.
    }
  };

  window.addEventListener("scroll", updateScrollDepth, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      void capturePage("hidden");
    }
  });
  window.addEventListener("beforeunload", () => {
    void capturePage("unload");
  });

  browser.runtime.onMessage.addListener((message: RuntimeMessage) => {
    if (message.type !== MESSAGE_TYPE_FORCE_CAPTURE) {
      return undefined;
    }

    void capturePage("manual");
    return Promise.resolve({ ok: true });
  });

  window.setTimeout(() => {
    void capturePage("timer");
  }, 8000);
}

function readText(): string {
  const target =
    document.querySelector("main") ??
    document.querySelector("article") ??
    document.body;

  if (!target) {
    return "";
  }

  return String(target.innerText ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

function detectPageSignals(): string[] {
  const signals: string[] = [];
  if (document.querySelector('input[type="password"]')) {
    signals.push("password-input");
  }
  if (document.querySelector("form[action*='checkout'], form[action*='payment']")) {
    signals.push("payment-form");
  }
  if (document.querySelector("input[name*='id'], input[name*='passport'], input[name*='ssn']")) {
    signals.push("identity-form");
  }
  return signals;
}
