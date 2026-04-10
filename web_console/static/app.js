const state = {
  providers: [],
  config: {},
  activeModel: {
    provider: "",
    base_url: "",
    api_key: "",
    default: "",
  },
  selectedProviderIndex: -1,
  history: [],
  saveTimer: null,
  dashboardTimer: null,
  logTimer: null,
  dragProviderIndex: -1,
  dragModelIndex: -1,
  chatMessages: [],
};

const $ = (id) => document.getElementById(id);

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdown(text) {
  const escaped = text || "";
  const blocks = escaped.split("```");
  const html = blocks
    .map((chunk, index) => {
      if (index % 2 === 1) {
        return `<pre><code>${escapeHtml(chunk)}</code></pre>`;
      }
      return escapeHtml(chunk)
        .replace(/^### (.*)$/gm, "<h3>$1</h3>")
        .replace(/^## (.*)$/gm, "<h2>$1</h2>")
        .replace(/^# (.*)$/gm, "<h1>$1</h1>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\n/g, "<br>");
    })
    .join("");
  return html;
}

async function api(path, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(options.headers || {}) };
  if (opts.body && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { ok: false, detail: raw };
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 428) {
      showAuthGate();
    }
    throw new Error(data.detail || `HTTP ${res.status}`);
  }
  return data;
}

function setSaveState(text, muted = false) {
  const el = $("statusSave");
  el.textContent = text;
  el.classList.toggle("muted", muted);
}

function showAuthGate() {
  $("authGate").classList.remove("hidden");
  $("appRoot").classList.add("hidden");
  stopTimers();
}

function showAppRoot() {
  $("authGate").classList.add("hidden");
  $("appRoot").classList.remove("hidden");
}

function stopTimers() {
  if (state.dashboardTimer) {
    clearInterval(state.dashboardTimer);
    state.dashboardTimer = null;
  }
  if (state.logTimer) {
    clearInterval(state.logTimer);
    state.logTimer = null;
  }
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      const target = button.dataset.tab;
      $(target).classList.add("active");
      if (target === "logs") {
        refreshLogs();
      }
    });
  });
}

async function checkAuthState() {
  const status = await api("/api/auth/status");
  $("authError").textContent = "";
  $("setupForm").classList.add("hidden");
  $("loginForm").classList.add("hidden");

  if (status.setup_required) {
    $("authHint").textContent = "First launch detected. Set an admin password to continue.";
    $("setupForm").classList.remove("hidden");
    showAuthGate();
    return;
  }
  if (status.authenticated) {
    await enterApp();
    return;
  }
  $("authHint").textContent = "Authentication required.";
  $("loginForm").classList.remove("hidden");
  showAuthGate();
}

async function enterApp() {
  showAppRoot();
  await Promise.all([
    refreshDashboard(),
    loadConfig(),
    loadBackups(),
    loadLogSources(),
  ]);
  if (!state.dashboardTimer) {
    state.dashboardTimer = setInterval(refreshDashboard, 5000);
  }
  restartLogTimer();
}

async function refreshDashboard() {
  const data = await api("/api/dashboard/state");
  const { system, hermes } = data;

  $("statusHermes").textContent = hermes.installed ? `Hermes: ${hermes.version || "installed"}` : "Hermes: missing";
  $("statusGateway").textContent = hermes.gateway_status.running ? "Gateway: running" : "Gateway: stopped";

  $("systemSnapshot").innerHTML = [
    `<li><span>OS</span><span>${escapeHtml(system.platform || "--")}</span></li>`,
    `<li><span>Host</span><span>${escapeHtml(system.hostname || "--")}</span></li>`,
    `<li><span>CPU</span><span>${Number(system.cpu_percent || 0).toFixed(1)}%</span></li>`,
    `<li><span>Memory</span><span>${formatBytes(system.memory_used)} / ${formatBytes(system.memory_total)}</span></li>`,
    `<li><span>Disk</span><span>${formatBytes(system.disk_used)} / ${formatBytes(system.disk_total)}</span></li>`,
    `<li><span>Uptime</span><span>${formatUptime(system.uptime_seconds)}</span></li>`,
  ].join("");

  $("hermesSnapshot").innerHTML = [
    `<li><span>Installed</span><span>${hermes.installed ? "yes" : "no"}</span></li>`,
    `<li><span>Version</span><span>${escapeHtml(hermes.version || "--")}</span></li>`,
    `<li><span>Binary</span><span>${escapeHtml(hermes.bin_path || "--")}</span></li>`,
    `<li><span>Gateway Installed</span><span>${hermes.gateway_installed ? "yes" : "no"}</span></li>`,
    `<li><span>Gateway Runtime</span><span>${hermes.gateway_status.running ? "running" : "stopped"}</span></li>`,
    `<li><span>Status Source</span><span>${escapeHtml(hermes.gateway_status.source || "--")}</span></li>`,
  ].join("");
}

function writeConsole(id, value) {
  const el = $(id);
  el.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  el.scrollTop = el.scrollHeight;
}

async function runServiceAction(action, outputId) {
  writeConsole(outputId, `Running ${action} ...`);
  const result = await api("/api/service/action", {
    method: "POST",
    body: { action },
  });
  writeConsole(outputId, result);
  await refreshDashboard();
}

function bindServiceButtons() {
  document.querySelectorAll(".action-btn[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      const outputId = button.closest("#dashboard") ? "quickActionOutput" : "serviceOutput";
      try {
        await runServiceAction(action, outputId);
      } catch (error) {
        writeConsole(outputId, `[error] ${error.message}`);
      }
    });
  });

  $("backupNowBtn").addEventListener("click", async () => {
    try {
      const result = await api("/api/config/backup", { method: "POST" });
      writeConsole("backupOutput", result);
      await loadBackups();
    } catch (error) {
      writeConsole("backupOutput", `[error] ${error.message}`);
    }
  });

  $("refreshBackupsBtn").addEventListener("click", loadBackups);
  $("restoreBtn").addEventListener("click", async () => {
    const backupName = $("backupSelect").value;
    if (!backupName) return;
    if (!window.confirm(`Restore backup ${backupName}?`)) return;
    try {
      const result = await api("/api/config/restore", {
        method: "POST",
        body: { backup_name: backupName },
      });
      writeConsole("backupOutput", result);
      await loadConfig();
    } catch (error) {
      writeConsole("backupOutput", `[error] ${error.message}`);
    }
  });
}

async function loadBackups() {
  try {
    const data = await api("/api/config/backups");
    const select = $("backupSelect");
    select.innerHTML = "";
    data.backups.forEach((backup) => {
      const opt = document.createElement("option");
      opt.value = backup.name;
      const date = new Date(backup.mtime * 1000).toLocaleString();
      opt.textContent = `${backup.name} (${date})`;
      select.appendChild(opt);
    });
    if (!data.backups.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No backups";
      select.appendChild(opt);
    }
  } catch (error) {
    writeConsole("backupOutput", `[error] ${error.message}`);
  }
}

async function loadLogSources() {
  try {
    const data = await api("/api/logs/sources");
    const select = $("logSourceSelect");
    select.innerHTML = "";
    data.sources.forEach((source) => {
      const opt = document.createElement("option");
      opt.value = source.id;
      opt.textContent = source.name;
      select.appendChild(opt);
    });
    if (!data.sources.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No log source";
      select.appendChild(opt);
    }
  } catch (error) {
    writeConsole("logOutput", `[error] ${error.message}`);
  }
}

async function refreshLogs() {
  const source = $("logSourceSelect").value;
  if (!source) return;
  const q = $("logKeywordInput").value.trim();
  try {
    const data = await api(`/api/logs/read?source=${encodeURIComponent(source)}&q=${encodeURIComponent(q)}&limit=400`);
    writeConsole("logOutput", data.text || "");
  } catch (error) {
    writeConsole("logOutput", `[error] ${error.message}`);
  }
}

function restartLogTimer() {
  if (state.logTimer) {
    clearInterval(state.logTimer);
    state.logTimer = null;
  }
  if ($("logAutoRefresh").checked) {
    state.logTimer = setInterval(refreshLogs, 3000);
  }
}

function pushHistory() {
  state.history.push({
    providers: deepClone(state.providers),
    config: deepClone(state.config),
    activeModel: deepClone(state.activeModel),
    selectedProviderIndex: state.selectedProviderIndex,
  });
  if (state.history.length > 40) {
    state.history.shift();
  }
}

function normalizeKey(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function syncProvidersIntoConfig() {
  const providersMap = {};
  state.providers.forEach((provider) => {
    const key = normalizeKey(provider.key || "");
    if (!key) return;
    const entry = {
      name: provider.name || key,
      api: provider.api || "",
      api_key: provider.api_key || "",
      default_model: provider.default_model || "",
    };
    const models = (provider.models || []).map((m) => String(m).trim()).filter(Boolean);
    if (models.length) {
      entry.models = models;
    }
    providersMap[key] = entry;
    provider.key = key;
  });
  state.config.providers = providersMap;
}

function syncActiveModelIntoConfig() {
  state.config.model = state.config.model || {};
  state.config.model.provider = state.activeModel.provider || "";
  state.config.model.base_url = state.activeModel.base_url || "";
  state.config.model.api_key = state.activeModel.api_key || "";
  state.config.model.default = state.activeModel.default || "";
}

function scheduleAutoSave() {
  setSaveState("Auto-save pending...");
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
  }
  state.saveTimer = setTimeout(saveConfigNow, 850);
}

async function saveConfigNow() {
  try {
    syncProvidersIntoConfig();
    syncActiveModelIntoConfig();
    await api("/api/config/save", {
      method: "POST",
      body: { config: state.config },
    });
    setSaveState(`Saved ${new Date().toLocaleTimeString()}`);
    renderChatProviderOptions();
  } catch (error) {
    setSaveState(`Save failed: ${error.message}`);
  }
}

function getSelectedProvider() {
  if (state.selectedProviderIndex < 0) return null;
  return state.providers[state.selectedProviderIndex] || null;
}

function renderProviderList() {
  const list = $("providerList");
  list.innerHTML = "";
  state.providers.forEach((provider, index) => {
    const li = document.createElement("li");
    li.className = `sortable-item ${index === state.selectedProviderIndex ? "active" : ""}`;
    li.dataset.index = String(index);
    li.draggable = true;
    li.innerHTML = `
      <span class="name">${escapeHtml(provider.key || `provider-${index + 1}`)}</span>
      <span class="ops">
        <button class="tiny ghost" data-cmd="up">up</button>
        <button class="tiny ghost" data-cmd="down">down</button>
      </span>
    `;
    li.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      state.selectedProviderIndex = index;
      renderProviderList();
      renderProviderEditor();
    });
    li.addEventListener("dragstart", () => {
      state.dragProviderIndex = index;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      state.dragProviderIndex = -1;
    });
    li.addEventListener("dragover", (event) => event.preventDefault());
    li.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = state.dragProviderIndex;
      const to = index;
      if (from < 0 || from === to) return;
      pushHistory();
      const [moved] = state.providers.splice(from, 1);
      state.providers.splice(to, 0, moved);
      state.selectedProviderIndex = to;
      renderProviderList();
      renderProviderEditor();
      scheduleAutoSave();
    });
    li.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const cmd = btn.dataset.cmd;
        if (cmd === "up" && index > 0) {
          pushHistory();
          [state.providers[index - 1], state.providers[index]] = [state.providers[index], state.providers[index - 1]];
          state.selectedProviderIndex = index - 1;
          renderProviderList();
          renderProviderEditor();
          scheduleAutoSave();
        }
        if (cmd === "down" && index < state.providers.length - 1) {
          pushHistory();
          [state.providers[index + 1], state.providers[index]] = [state.providers[index], state.providers[index + 1]];
          state.selectedProviderIndex = index + 1;
          renderProviderList();
          renderProviderEditor();
          scheduleAutoSave();
        }
      });
    });
    list.appendChild(li);
  });
}

function renderModelList() {
  const provider = getSelectedProvider();
  const list = $("modelList");
  list.innerHTML = "";
  if (!provider) return;
  provider.models = provider.models || [];

  provider.models.forEach((modelName, index) => {
    const li = document.createElement("li");
    li.className = "sortable-item";
    li.draggable = true;
    li.innerHTML = `
      <span class="name">${escapeHtml(modelName)}</span>
      <span class="ops">
        <button class="tiny ghost" data-cmd="edit">edit</button>
        <button class="tiny danger" data-cmd="del">del</button>
      </span>
    `;
    li.addEventListener("dragstart", () => {
      state.dragModelIndex = index;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      state.dragModelIndex = -1;
    });
    li.addEventListener("dragover", (event) => event.preventDefault());
    li.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = state.dragModelIndex;
      const to = index;
      if (from < 0 || from === to) return;
      pushHistory();
      const [moved] = provider.models.splice(from, 1);
      provider.models.splice(to, 0, moved);
      renderModelList();
      scheduleAutoSave();
    });
    li.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const cmd = btn.dataset.cmd;
        if (cmd === "del") {
          pushHistory();
          provider.models.splice(index, 1);
          renderModelList();
          scheduleAutoSave();
        }
        if (cmd === "edit") {
          const next = window.prompt("Model name", modelName);
          if (!next) return;
          pushHistory();
          provider.models[index] = next.trim();
          renderModelList();
          scheduleAutoSave();
        }
      });
    });
    list.appendChild(li);
  });
}

function renderProviderEditor() {
  const provider = getSelectedProvider();
  if (!provider) {
    $("providerEditor").classList.add("hidden");
    $("noProviderHint").classList.remove("hidden");
    return;
  }
  $("providerEditor").classList.remove("hidden");
  $("noProviderHint").classList.add("hidden");
  $("providerKey").value = provider.key || "";
  $("providerName").value = provider.name || "";
  $("providerApi").value = provider.api || "";
  $("providerApiKey").value = provider.api_key || "";
  $("providerDefaultModel").value = provider.default_model || "";
  renderModelList();
}

function bindModelEditorEvents() {
  ["providerKey", "providerName", "providerApi", "providerApiKey", "providerDefaultModel"].forEach((id) => {
    $(id).addEventListener("change", () => pushHistory());
    $(id).addEventListener("input", () => {
      const provider = getSelectedProvider();
      if (!provider) return;
      provider.key = $("providerKey").value.trim();
      provider.name = $("providerName").value.trim();
      provider.api = $("providerApi").value.trim();
      provider.api_key = $("providerApiKey").value.trim();
      provider.default_model = $("providerDefaultModel").value.trim();
      renderProviderList();
      scheduleAutoSave();
    });
  });

  $("addProviderBtn").addEventListener("click", () => {
    const input = window.prompt("New provider key");
    if (!input) return;
    const key = normalizeKey(input);
    if (!key) return;
    if (state.providers.some((provider) => provider.key === key)) {
      window.alert("Provider key already exists");
      return;
    }
    pushHistory();
    state.providers.push({
      key,
      name: key,
      api: "",
      api_key: "",
      default_model: "",
      models: [],
    });
    state.selectedProviderIndex = state.providers.length - 1;
    renderProviderList();
    renderProviderEditor();
    scheduleAutoSave();
  });

  $("deleteProviderBtn").addEventListener("click", () => {
    const provider = getSelectedProvider();
    if (!provider) return;
    if (!window.confirm(`Delete provider ${provider.key}?`)) return;
    pushHistory();
    state.providers.splice(state.selectedProviderIndex, 1);
    state.selectedProviderIndex = Math.min(state.selectedProviderIndex, state.providers.length - 1);
    renderProviderList();
    renderProviderEditor();
    scheduleAutoSave();
  });

  $("addModelBtn").addEventListener("click", () => {
    const provider = getSelectedProvider();
    if (!provider) return;
    const model = window.prompt("Model name");
    if (!model) return;
    pushHistory();
    provider.models = provider.models || [];
    provider.models.push(model.trim());
    renderModelList();
    scheduleAutoSave();
  });

  $("undoBtn").addEventListener("click", () => {
    if (state.history.length < 2) return;
    state.history.pop();
    const snapshot = state.history[state.history.length - 1];
    state.providers = deepClone(snapshot.providers);
    state.config = deepClone(snapshot.config);
    state.activeModel = deepClone(snapshot.activeModel);
    state.selectedProviderIndex = snapshot.selectedProviderIndex;
    renderAllModelViews();
    scheduleAutoSave();
  });

  ["activeProvider", "activeBaseUrl", "activeApiKey", "activeDefaultModel"].forEach((id) => {
    $(id).addEventListener("change", () => pushHistory());
    $(id).addEventListener("input", () => {
      state.activeModel.provider = $("activeProvider").value.trim();
      state.activeModel.base_url = $("activeBaseUrl").value.trim();
      state.activeModel.api_key = $("activeApiKey").value.trim();
      state.activeModel.default = $("activeDefaultModel").value.trim();
      scheduleAutoSave();
    });
  });

  $("testAllModelsBtn").addEventListener("click", testAllModels);
  $("testCurrentProviderBtn").addEventListener("click", testCurrentProvider);
  $("saveRawBtn").addEventListener("click", saveRawYaml);
}

function renderAllModelViews() {
  renderProviderList();
  renderProviderEditor();
  $("activeProvider").value = state.activeModel.provider || "";
  $("activeBaseUrl").value = state.activeModel.base_url || "";
  $("activeApiKey").value = state.activeModel.api_key || "";
  $("activeDefaultModel").value = state.activeModel.default || "";
  renderChatProviderOptions();
}

async function loadConfig() {
  const data = await api("/api/config");
  state.config = deepClone(data.view.raw || {});
  state.providers = deepClone(data.view.providers || []);
  state.activeModel = deepClone(data.view.active_model || state.activeModel);
  state.selectedProviderIndex = state.providers.length ? 0 : -1;
  state.history = [];
  pushHistory();
  renderAllModelViews();
  $("rawYamlEditor").value = data.raw_yaml || "";
}

async function saveRawYaml() {
  const raw = $("rawYamlEditor").value;
  try {
    await api("/api/config/raw", {
      method: "POST",
      body: { raw_yaml: raw },
    });
    setSaveState(`Raw YAML saved ${new Date().toLocaleTimeString()}`);
    await loadConfig();
  } catch (error) {
    setSaveState(`Raw save failed: ${error.message}`);
  }
}

function renderTestResults(results) {
  const wrapper = $("testResults");
  wrapper.innerHTML = "";
  results.forEach((item) => {
    const div = document.createElement("div");
    div.className = `test-item ${item.ok ? "ok" : "err"}`;
    div.innerHTML = `
      <strong>${escapeHtml(item.provider_key || "unknown")} / ${escapeHtml(item.model)}</strong><br>
      latency: ${item.latency_ms ?? "--"}ms | status: ${item.status_code}<br>
      ${escapeHtml(item.error || "ok")}
    `;
    wrapper.appendChild(div);
  });
}

async function testAllModels() {
  $("testResults").innerHTML = "<div class='test-item'>Testing all model targets...</div>";
  try {
    const result = await api("/api/models/test", { method: "POST", body: {} });
    renderTestResults(result.results || []);
  } catch (error) {
    $("testResults").innerHTML = `<div class='test-item err'>${escapeHtml(error.message)}</div>`;
  }
}

async function testCurrentProvider() {
  const provider = getSelectedProvider();
  if (!provider) return;
  const models = provider.models && provider.models.length ? provider.models : [provider.default_model];
  const targets = models
    .filter(Boolean)
    .map((model) => ({
      provider_key: provider.key,
      model,
      api_base_url: provider.api,
      api_key: provider.api_key || "",
    }));
  if (!targets.length) return;
  $("testResults").innerHTML = "<div class='test-item'>Testing current provider...</div>";
  try {
    const result = await api("/api/models/test", {
      method: "POST",
      body: { targets },
    });
    renderTestResults(result.results || []);
  } catch (error) {
    $("testResults").innerHTML = `<div class='test-item err'>${escapeHtml(error.message)}</div>`;
  }
}

function renderChatProviderOptions() {
  const select = $("chatProviderSelect");
  const current = select.value;
  select.innerHTML = "";
  const autoOpt = document.createElement("option");
  autoOpt.value = "";
  autoOpt.textContent = "Auto";
  select.appendChild(autoOpt);
  state.providers.forEach((provider) => {
    const opt = document.createElement("option");
    opt.value = provider.key;
    opt.textContent = `${provider.key} (${provider.default_model || "no default"})`;
    select.appendChild(opt);
  });
  if (current) {
    select.value = current;
  }
}

function appendChatMessage(role, content) {
  state.chatMessages.push({ role, content });
  const wrapper = $("chatMessages");
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  if (role === "assistant") {
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  wrapper.appendChild(div);
  wrapper.scrollTop = wrapper.scrollHeight;
  return div;
}

async function streamChatReply(payload, targetEl) {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let finalText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    finalText += chunk;
    targetEl.innerHTML = renderMarkdown(finalText);
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  }
  return finalText;
}

function bindChatEvents() {
  $("chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("chatInput");
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = "";

    const history = state.chatMessages.slice(-10).map((item) => ({ role: item.role, content: item.content }));
    appendChatMessage("user", prompt);
    const assistantEl = appendChatMessage("assistant", "...");
    const assistantIndex = state.chatMessages.length - 1;

    const payload = {
      messages: [...history, { role: "user", content: prompt }],
      provider_key: $("chatProviderSelect").value || null,
      model: $("chatModelInput").value.trim() || null,
      temperature: 0.2,
    };

    try {
      const answer = await streamChatReply(payload, assistantEl);
      state.chatMessages[assistantIndex].content = answer;
    } catch (error) {
      assistantEl.textContent = `[error] ${error.message}`;
      state.chatMessages[assistantIndex].content = `[error] ${error.message}`;
    }
  });
}

function bindAuthEvents() {
  $("setupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("setupPassword").value;
    try {
      await api("/api/auth/setup", {
        method: "POST",
        body: { password },
      });
      await enterApp();
    } catch (error) {
      $("authError").textContent = error.message;
    }
  });

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("loginPassword").value;
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: { password },
      });
      await enterApp();
    } catch (error) {
      $("authError").textContent = error.message;
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    showAuthGate();
    await checkAuthState();
  });
}

function bindLogEvents() {
  $("logRefreshBtn").addEventListener("click", refreshLogs);
  $("logSourceSelect").addEventListener("change", refreshLogs);
  $("logKeywordInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      refreshLogs();
    }
  });
  $("logAutoRefresh").addEventListener("change", restartLogTimer);
}

async function bootstrap() {
  bindTabs();
  bindServiceButtons();
  bindModelEditorEvents();
  bindChatEvents();
  bindAuthEvents();
  bindLogEvents();
  setSaveState("Auto-save idle", true);
  await checkAuthState();
}

window.addEventListener("DOMContentLoaded", bootstrap);
