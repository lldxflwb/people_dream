const baseUrl = window.location.origin;
const stateUrl = `${baseUrl}/api/state`;
const uiState = {
  currentDay: new URL(window.location.href).searchParams.get("day") || "",
  availableDays: [],
  dreamTaskId: "",
  dreamTaskTimer: 0
};

function buildStateUrl(day) {
  const url = new URL(stateUrl);
  if (day) {
    url.searchParams.set("day", day);
  }
  return url.toString();
}

async function fetchState(day) {
  const response = await fetch(buildStateUrl(day));
  if (!response.ok) {
    throw new Error("无法读取 demo 状态");
  }
  return response.json();
}

async function fetchDreamTask(taskId) {
  const response = await fetch(`${baseUrl}/api/dream-report-tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    throw new Error(payload && payload.message ? payload.message : "梦境任务状态读取失败");
  }
  return response.json();
}

function clearDreamTaskPolling() {
  if (uiState.dreamTaskTimer) {
    clearTimeout(uiState.dreamTaskTimer);
    uiState.dreamTaskTimer = 0;
  }
}

function scheduleDreamTaskPolling(taskId) {
  uiState.dreamTaskId = taskId;
  clearDreamTaskPolling();
  uiState.dreamTaskTimer = window.setTimeout(() => {
    pollDreamTask(taskId).catch((error) => {
      document.getElementById("dreamReportStatus").textContent = error.message;
    });
  }, 2000);
}

async function pollDreamTask(taskId) {
  const task = await fetchDreamTask(taskId);
  if (uiState.dreamTaskId !== taskId) {
    return;
  }

  if (task.status === "pending" || task.status === "running") {
    document.getElementById("dreamReportStatus").textContent = describeDreamReport(null, task);
    scheduleDreamTaskPolling(taskId);
    return;
  }

  uiState.dreamTaskId = "";
  clearDreamTaskPolling();
  await load(task.day);
}

function syncBrowserUrl(day) {
  const url = new URL(window.location.href);
  if (day) {
    url.searchParams.set("day", day);
  } else {
    url.searchParams.delete("day");
  }
  history.replaceState({}, "", url);
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

function formatLocalTime(value) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString("zh-CN", {
    hour12: false
  });
}

function formatDaySummary(state) {
  if (!state.availableDays.length) {
    return "还没有形成可翻页的采集日。";
  }

  const currentIndex = state.availableDays.indexOf(state.currentDay);
  if (currentIndex === -1) {
    return `当前查看 ${state.currentDay}，已记录 ${state.availableDays.length} 天。`;
  }
  return `当前查看 ${state.currentDay}，第 ${currentIndex + 1} / ${state.availableDays.length} 天。`;
}

function renderDayPager(state) {
  uiState.currentDay = state.currentDay || "";
  uiState.availableDays = Array.isArray(state.availableDays) ? state.availableDays : [];
  syncBrowserUrl(uiState.currentDay);

  const currentIndex = uiState.availableDays.indexOf(uiState.currentDay);
  const hasPrev = currentIndex >= 0 && currentIndex < uiState.availableDays.length - 1;
  const hasNext = currentIndex > 0;

  document.getElementById("currentDayState").textContent = uiState.currentDay
    ? `查看 ${uiState.currentDay}`
    : "查看日期";
  document.getElementById("daySummary").textContent = formatDaySummary(state);
  document.getElementById("prevDayButton").disabled = !hasPrev;
  document.getElementById("nextDayButton").disabled = !hasNext;
  document.getElementById("latestDayButton").disabled =
    uiState.availableDays.length === 0 || currentIndex === 0;
}

async function load(day = uiState.currentDay) {
  const state = await fetchState(day);
  renderDayPager(state);
  const dreamTask = state.dreamTask || null;

  document.getElementById("pausedState").textContent = state.settings.paused ? "已暂停采集" : "采集中";
  document.getElementById("trackedStats").textContent = `${state.report.stats.trackedPages} 条资源`;
  document.getElementById("blockedStats").textContent = `${state.report.stats.blockedEvents} 次拦截`;
  document.getElementById("overview").textContent = state.report.overview;

  document.getElementById("reportTitle").textContent = `${state.currentDay} 梦报`;
  document.getElementById("dreamReportMeta").textContent =
    state.report.meta.source === "codex" ? "AI 推理版" : "规则回退版";
  document.getElementById("resourcesTitle").textContent = `${state.currentDay} 收集页面`;
  document.getElementById("blockedTitle").textContent = `${state.currentDay} 拦截记录`;
  document.getElementById("dreamReportStatus").textContent = describeDreamReport(state.report, dreamTask);

  const generateDreamButton = document.getElementById("generateDreamButton");
  const hasData = state.report.stats.trackedPages > 0 || state.report.stats.blockedEvents > 0;
  const taskInFlight = dreamTask && (dreamTask.status === "pending" || dreamTask.status === "running");
  generateDreamButton.textContent = taskInFlight
    ? "任务执行中..."
    : state.report.meta.source === "codex"
      ? "重新生成 AI 梦报"
      : "生成 AI 梦报";
  generateDreamButton.disabled = !state.report.meta.authReady || !hasData || Boolean(taskInFlight);

  if (taskInFlight) {
    scheduleDreamTaskPolling(dreamTask.id);
  } else {
    uiState.dreamTaskId = "";
    clearDreamTaskPolling();
  }

  renderList(
    document.getElementById("themes"),
    state.report.themes,
    "这一天还没有稳定主题。",
    (item) => `<li>${item.keyword} <span class="muted">score ${item.score}</span></li>`
  );

  renderList(
    document.getElementById("ongoingResources"),
    state.report.ongoingResources,
    "这一天还没有形成持续关注页面。",
    (item) =>
      `<li>${item.title || "未命名页面"} <span class="muted">${item.visitCount} 次访问 / ${item.versionCount} 个版本</span></li>`
  );

  renderList(
    document.getElementById("unfinishedQuestions"),
    state.report.unfinishedQuestions,
    "这一天还没有形成未完成问题。",
    (item) => `<li>${item}</li>`
  );

  renderList(
    document.getElementById("connections"),
    state.report.connections,
    "这一天还没有形成明确连接。",
    (item) => `<li>${item}</li>`
  );

  renderList(
    document.getElementById("suggestions"),
    state.report.suggestions,
    "这一天还没有后续建议。",
    (item) => `<li>${item}</li>`
  );

  renderList(
    document.getElementById("resources"),
    state.resources,
    "这一天还没有采集到页面。",
    (resource) => `
      <article class="resource">
        <div class="row" style="justify-content: space-between;">
          <strong>${resource.latestTitle || "Untitled page"}</strong>
          <div class="row">
            <span class="pill">${resource.visitCount} 次访问 / ${resource.versionCount} 个新版本</span>
            <button class="secondary" data-delete-resource="${resource.id}">删除</button>
          </div>
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
    "这一天还没有拦截记录。",
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

function describeDreamReport(report, dreamTask) {
  if (dreamTask && (dreamTask.status === "pending" || dreamTask.status === "running")) {
    return `AI 梦报任务执行中，任务 ID ${dreamTask.id.slice(0, 8)}，创建于 ${formatLocalTime(dreamTask.createdAt)}。`;
  }

  if (dreamTask && dreamTask.status === "failed") {
    return `AI 梦报任务失败：${dreamTask.errorMessage || "请重新生成。"} `;
  }

  if (!report) {
    return "梦报状态读取中。";
  }

  if (!report.meta.authReady) {
    return "未检测到本地 Codex 登录态，当前显示规则版梦报。";
  }

  if (report.meta.source === "codex") {
    return `当前显示 AI 推理版梦报，生成于 ${formatLocalTime(report.generatedAt)}，模型 ${report.meta.model}。`;
  }

  if (report.meta.stale) {
    return "日间数据刚发生变化，当前显示回退版梦报。点击“生成 AI 梦报”可以刷新推理。";
  }

  return "当前显示规则版梦报。点击“生成 AI 梦报”可使用本地 Codex 登录态做一次推理。";
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
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    throw new Error(payload && payload.message ? payload.message : "请求失败");
  }
  return response.json();
}

document.getElementById("refreshButton").addEventListener("click", () => {
  load().catch((error) => alert(error.message));
});

document.getElementById("pauseButton").addEventListener("click", async () => {
  const state = await fetchState(uiState.currentDay);
  await postJson(`${baseUrl}/api/pause`, {
    paused: !state.settings.paused
  });
  await load(uiState.currentDay);
});

document.getElementById("generateDreamButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "生成中...";

  try {
    const result = await postJson(`${baseUrl}/api/dream-report-tasks`, {
      day: uiState.currentDay
    });
    if (result && result.task && result.task.id) {
      scheduleDreamTaskPolling(result.task.id);
    }
    await load(uiState.currentDay);
  } catch (error) {
    alert(error.message);
  } finally {
    button.textContent = originalText;
  }
});

document.getElementById("prevDayButton").addEventListener("click", async () => {
  const index = uiState.availableDays.indexOf(uiState.currentDay);
  if (index === -1 || index >= uiState.availableDays.length - 1) {
    return;
  }
  await load(uiState.availableDays[index + 1]);
});

document.getElementById("nextDayButton").addEventListener("click", async () => {
  const index = uiState.availableDays.indexOf(uiState.currentDay);
  if (index <= 0) {
    return;
  }
  await load(uiState.availableDays[index - 1]);
});

document.getElementById("latestDayButton").addEventListener("click", async () => {
  if (!uiState.availableDays.length) {
    return;
  }
  await load(uiState.availableDays[0]);
});

document.getElementById("ruleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  await postJson(`${baseUrl}/api/blacklist`, {
    kind: formData.get("kind"),
    mode: formData.get("mode"),
    pattern: formData.get("pattern")
  });
  event.currentTarget.reset();
  await load(uiState.currentDay);
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-rule]");
  if (button) {
    const ruleId = button.getAttribute("data-delete-rule");
    const response = await fetch(`${baseUrl}/api/blacklist/${encodeURIComponent(ruleId)}`, {
      method: "DELETE"
    });
    if (!response.ok) {
      throw new Error("删除规则失败");
    }
    await load(uiState.currentDay);
    return;
  }

  const resourceButton = event.target.closest("[data-delete-resource]");
  if (!resourceButton) {
    return;
  }

  const resourceId = resourceButton.getAttribute("data-delete-resource");
  const requestUrl = new URL(`${baseUrl}/api/resources/${encodeURIComponent(resourceId)}`);
  if (uiState.currentDay) {
    requestUrl.searchParams.set("day", uiState.currentDay);
  }

  const response = await fetch(requestUrl.toString(), {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error("删除记录失败");
  }
  await load(uiState.currentDay);
});

load().catch((error) => {
  document.getElementById("overview").textContent = error.message;
});
