const stateUrl = "http://127.0.0.1:4017/api/state";

async function fetchState() {
  const response = await fetch(stateUrl);
  if (!response.ok) {
    throw new Error("无法读取 demo 状态");
  }
  return response.json();
}

function renderList(target, items, fallbackText, renderer) {
  target.innerHTML = "";
  if (!items || items.length === 0) {
    target.innerHTML = `<li class="muted">${fallbackText}</li>`;
    return;
  }

  for (const item of items) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderer(item);
    target.appendChild(wrapper.firstElementChild);
  }
}

async function load() {
  const state = await fetchState();
  document.getElementById("pausedState").textContent = state.settings.paused ? "已暂停采集" : "采集中";
  document.getElementById("trackedStats").textContent = `${state.report.stats.trackedPages} 条资源`;
  document.getElementById("blockedStats").textContent = `${state.report.stats.blockedEvents} 次拦截`;
  document.getElementById("overview").textContent = state.report.overview;

  renderList(
    document.getElementById("themes"),
    state.report.themes,
    "还没有主题",
    (item) => `<li>${item.keyword} <span class="muted">score ${item.score}</span></li>`
  );

  renderList(
    document.getElementById("suggestions"),
    state.report.suggestions,
    "还没有建议",
    (item) => `<li>${item}</li>`
  );

  renderList(
    document.getElementById("resources"),
    state.resources,
    "还没有采集到页面。",
    (resource) => `
      <article class="resource">
        <div class="row" style="justify-content: space-between;">
          <strong>${resource.latestTitle || "Untitled page"}</strong>
          <span class="pill">${resource.visitCount} 次访问 / ${resource.versionCount} 个版本</span>
        </div>
        <p class="muted">${resource.latestExcerpt || "暂无摘要"}</p>
        <p><a href="${resource.normalizedUrl}" target="_blank" rel="noreferrer">${resource.host}</a></p>
        <code>${resource.normalizedUrl}</code>
      </article>
    `
  );

  renderList(
    document.getElementById("rules"),
    state.settings.blacklist,
    "还没有黑名单规则。",
    (rule) => `
      <article class="rule">
        <div class="row" style="justify-content: space-between;">
          <strong>${rule.kind} / ${rule.mode}</strong>
          <button class="secondary" data-delete-rule="${rule.id}">删除</button>
        </div>
        <code>${rule.pattern}</code>
      </article>
    `
  );

  renderList(
    document.getElementById("blockedEvents"),
    state.blockedEvents,
    "还没有拦截记录。",
    (event) => `
      <article class="blocked">
        <div class="row" style="justify-content: space-between;">
          <strong>${event.title || "blocked event"}</strong>
          <span class="pill">${event.rule.mode}</span>
        </div>
        <p class="muted">${event.blockedAt}</p>
        <code>${event.url}</code>
      </article>
    `
  );
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

document.getElementById("refreshButton").addEventListener("click", () => {
  load().catch((error) => alert(error.message));
});

document.getElementById("pauseButton").addEventListener("click", async () => {
  const state = await fetchState();
  await postJson("http://127.0.0.1:4017/api/pause", {
    paused: !state.settings.paused
  });
  await load();
});

document.getElementById("ruleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  await postJson("http://127.0.0.1:4017/api/blacklist", {
    kind: formData.get("kind"),
    mode: formData.get("mode"),
    pattern: formData.get("pattern")
  });
  event.currentTarget.reset();
  await load();
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-rule]");
  if (!button) {
    return;
  }

  const ruleId = button.getAttribute("data-delete-rule");
  const response = await fetch(`http://127.0.0.1:4017/api/blacklist/${encodeURIComponent(ruleId)}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error("删除规则失败");
  }
  await load();
});

load().catch((error) => {
  document.getElementById("overview").textContent = error.message;
});
