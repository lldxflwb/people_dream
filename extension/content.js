(function () {
  const state = {
    enteredAt: Date.now(),
    maxScrollDepth: 0,
    sent: false
  };

  function readText() {
    const target =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.body;

    if (!target) {
      return "";
    }

    return String(target.innerText || "").replace(/\s+/g, " ").trim().slice(0, 12000);
  }

  function detectPageSignals() {
    const signals = [];
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

  function updateScrollDepth() {
    const maxScrollable = Math.max(
      document.documentElement.scrollHeight - window.innerHeight,
      1
    );
    const currentDepth = Math.min(100, Math.round((window.scrollY / maxScrollable) * 100));
    state.maxScrollDepth = Math.max(state.maxScrollDepth, currentDepth);
  }

  function capturePage(reason) {
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
    chrome.runtime.sendMessage({
      type: "capture-page",
      payload: {
        url: location.href,
        title: document.title,
        textContent,
        excerpt: textContent.slice(0, 240),
        capturedAt: new Date().toISOString(),
        dwellMs,
        scrollDepth: state.maxScrollDepth,
        reason,
        pageSignals: detectPageSignals()
      }
    });
  }

  window.addEventListener("scroll", updateScrollDepth, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      capturePage("hidden");
    }
  });

  window.addEventListener("beforeunload", () => {
    capturePage("unload");
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "force-capture") {
      return;
    }
    capturePage("manual");
    sendResponse({ ok: true });
  });

  setTimeout(() => capturePage("timer"), 8000);
})();
