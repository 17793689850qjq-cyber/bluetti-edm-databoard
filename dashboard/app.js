/* global Chart */

let DATA = null;
let pieChart = null;
let barChart = null;
let metricView = "combined";
let currentPeriod = { preset: "30d", start: null, end: null };

const PERIOD_STORAGE_KEY = "bluetti-dashboard-period";
const PRESET_DAYS = { "7d": 7, "30d": 30, "60d": 60, "90d": 90 };
const GITHUB_REPO = "17793689850qjq-cyber/bluetti-edm-dashboard";
const CUSTOM_POLL_INTERVAL_MS = 30000;
const CUSTOM_POLL_MAX_MS = 900000;
const CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const SYNC_ETA_MINUTES = 7;
const TRIGGER_SYNC_URL = "/.netlify/functions/trigger-sync";
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function setupDatePickerLimits() {
  const today = todayISO();
  const startEl = $("#period-start");
  const endEl = $("#period-end");
  if (startEl) {
    startEl.max = today;
    if (startEl.value && startEl.value > today) startEl.value = today;
  }
  if (endEl) {
    endEl.max = today;
    if (endEl.value && endEl.value > today) endEl.value = today;
  }
}

function dataUpdatedAtMs(data) {
  const raw = data?.meta?.updatedAt;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function dataIsFresh(data) {
  const ts = dataUpdatedAtMs(data);
  if (!ts) return false;
  return Date.now() - ts < CACHE_STALE_MS;
}

function estimateSyncRemainingMinutes(elapsedMs) {
  const totalMs = SYNC_ETA_MINUTES * 60 * 1000;
  const remaining = Math.max(1, Math.ceil((totalMs - elapsedMs) / 60000));
  return remaining;
}

function shouldTriggerCustomSync(period, data) {
  if (!data) return true;
  if (!dataIsFresh(data)) return true;
  return comparisonsMissingForPeriod(period, data);
}

let customPollTimer = null;
let customPollStartedAt = 0;
let customPollPeriod = null;
let syncTriggeredKey = null;
let comparisonResyncKey = null;
let comparisonScope = "global";
let comparisonSite = "US";
let comparisonHandlersBound = false;
let comparisonGmvChart = null;
let comparisonRatesChart = null;
let comparisonDeliveredChart = null;
let comparisonEngagementRatesChart = null;
let flowYoYSite = "US";
let flowYoYSort = { key: "curDelivered", asc: false };
let flowYoYHandlersBound = false;

const $ = (sel) => document.querySelector(sel);

function pct(x, digits = 1) {
  return `${(x * 100).toFixed(digits)}%`;
}

function cny(n) {
  if (n >= 1e6) return `¥${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `¥${Math.round(n / 1e3)}K`;
  return `¥${Math.round(n)}`;
}

function localGmv(n, currency) {
  if (currency === "CLP" || currency === "JPY") {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M ${currency}`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K ${currency}`;
  }
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ${currency}`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K ${currency}`;
  return `${Math.round(n)} ${currency}`;
}

function dualGmv(local, currency, cnyVal) {
  return `${localGmv(local, currency)} / ${cny(cnyVal)}`;
}

function pickMetrics(row, view) {
  if (view === "campaign") return row.campaign;
  if (view === "flow") return row.flow;
  const c = row.campaign;
  const f = row.flow;
  const delivered = c.delivered + f.delivered || 1;
  return {
    openRate: (c.openRate * c.delivered + f.openRate * f.delivered) / delivered,
    clickRate: (c.clickRate * c.delivered + f.clickRate * f.delivered) / delivered,
    convRate: (c.conversions + f.conversions) / delivered,
    delivered,
  };
}

function viewGmv(row, view) {
  if (view === "campaign") {
    return { local: row.campaign.gmv, cny: row.campaignGmvCny, campLocal: row.campaign.gmv, campCny: row.campaignGmvCny, flowLocal: 0, flowCny: 0 };
  }
  if (view === "flow") {
    return { local: row.flow.gmv, cny: row.flowGmvCny, campLocal: 0, campCny: 0, flowLocal: row.flow.gmv, flowCny: row.flowGmvCny };
  }
  return {
    local: row.campaign.gmv + row.flow.gmv,
    cny: row.totalGmvCny,
    campLocal: row.campaign.gmv,
    campCny: row.campaignGmvCny,
    flowLocal: row.flow.gmv,
    flowCny: row.flowGmvCny,
  };
}

function aggregateView(view) {
  let delivered = 0;
  let openW = 0;
  let clickW = 0;
  let conv = 0;
  let gmvCny = 0;
  let campaignCny = 0;
  let flowCny = 0;

  for (const row of DATA.rows) {
    const c = row.campaign;
    const f = row.flow;
    if (view === "campaign" || view === "combined") {
      delivered += c.delivered;
      openW += c.openRate * c.delivered;
      clickW += c.clickRate * c.delivered;
      conv += c.conversions;
      campaignCny += row.campaignGmvCny;
    }
    if (view === "flow" || view === "combined") {
      delivered += f.delivered;
      openW += f.openRate * f.delivered;
      clickW += f.clickRate * f.delivered;
      conv += f.conversions;
      flowCny += row.flowGmvCny;
    }
  }

  if (view === "campaign") {
    gmvCny = campaignCny;
  } else if (view === "flow") {
    gmvCny = flowCny;
  } else {
    gmvCny = campaignCny + flowCny;
  }

  const d = delivered || 1;
  const totalParts = campaignCny + flowCny || 1;
  return {
    gmvCny,
    campaignCny,
    flowCny,
    campaignShare: view === "flow" ? 0 : campaignCny / totalParts,
    flowShare: view === "campaign" ? 0 : flowCny / totalParts,
    openRate: openW / d,
    clickRate: clickW / d,
    convRate: conv / d,
  };
}

function rowTone(row, totalGmv, view) {
  const share = viewGmv(row, view).cny / totalGmv;
  if (share >= 0.15) return "tone-top";
  return "";
}

function alertTone(priority) {
  if (priority === "P0") return "tone-p0";
  if (priority === "P1") return "tone-p1";
  return "tone-warn";
}

function normalizePeriod(metaPeriod) {
  if (!metaPeriod) return { label: "近30天", days: 30, start: null, end: null, preset: "30d" };
  if (typeof metaPeriod === "string") {
    return { label: metaPeriod.replace(/\s/g, ""), days: 30, start: null, end: null, preset: "30d" };
  }
  return metaPeriod;
}

function periodLabel(period) {
  const p = normalizePeriod(period);
  if (p.start && p.end) return `${p.label || "自定义"} · ${p.start} ~ ${p.end}`;
  if (p.start && p.end === undefined) return p.label || "近30天";
  return p.label || `近${p.days || 30}天`;
}

function dataUrlForPeriod(period) {
  if (period.preset === "custom") {
    if (!period.start || !period.end) {
      throw new Error("自定义区间需选择开始与结束日期");
    }
    return `data/dashboard-custom-${period.start}_${period.end}.json`;
  }
  const days = PRESET_DAYS[period.preset] || 30;
  if (days === 30) return "data/dashboard-30d.json";
  return `data/dashboard-${days}d.json`;
}

function loadStoredPeriod() {
  try {
    const raw = localStorage.getItem(PERIOD_STORAGE_KEY);
    if (!raw) return { preset: "30d" };
    const parsed = JSON.parse(raw);
    if (parsed.preset === "custom" && parsed.start && parsed.end) return parsed;
    if (parsed.preset && PRESET_DAYS[parsed.preset]) return { preset: parsed.preset };
  } catch (_) {
    /* ignore */
  }
  return { preset: "30d" };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Clamp custom end date to today when user picks a future end (no data yet). */
function normalizeCustomPeriod(start, end) {
  const today = todayIso();
  if (end > today) {
    return {
      start,
      end: today,
      clamped: true,
      message: `结束日期已调整为今天（${today}），未来日期暂无数据`,
    };
  }
  return { start, end, clamped: false, message: null };
}

function savePeriod(period) {
  localStorage.setItem(PERIOD_STORAGE_KEY, JSON.stringify(period));
}

function readUrlPeriod() {
  const params = new URLSearchParams(window.location.search);
  const start = params.get("start");
  const end = params.get("end");
  if (start && end) {
    const norm = normalizeCustomPeriod(start, end);
    return { preset: "custom", start: norm.start, end: norm.end };
  }
  const preset = params.get("period");
  if (preset && PRESET_DAYS[preset]) return { preset };
  return null;
}

function syncPeriodUi(period) {
  document.querySelectorAll(".period-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === period.preset);
  });
  if (period.preset === "custom") {
    if ($("#period-start")) $("#period-start").value = period.start || "";
    if ($("#period-end")) $("#period-end").value = period.end || "";
  }
}

function workflowSyncUrl() {
  return `https://github.com/${GITHUB_REPO}/actions/workflows/sync-dashboard.yml`;
}

function workflowDispatchUrl(start, end) {
  const url = new URL(workflowSyncUrl());
  url.searchParams.set("query", "workflow_dispatch");
  if (start) url.searchParams.set("inputs[start_date]", start);
  if (end) url.searchParams.set("inputs[end_date]", end);
  return url.toString();
}

function stopCustomPolling() {
  if (customPollTimer) {
    clearInterval(customPollTimer);
    customPollTimer = null;
  }
  customPollPeriod = null;
  customPollStartedAt = 0;
  $("#custom-empty")?.classList.remove("syncing");
}

function updateCustomPollStatus(period, elapsedMs, { syncing = true } = {}) {
  const el = $("#custom-poll-status");
  if (!el) return;
  const mins = Math.floor(elapsedMs / 60000);
  const secs = Math.floor((elapsedMs % 60000) / 1000);
  if (syncing) {
    const eta = estimateSyncRemainingMinutes(elapsedMs);
    el.textContent = `正在后台同步 · ${period.start} ~ ${period.end} · 已等待 ${mins}:${String(secs).padStart(2, "0")} · 预计还需约 ${eta} 分钟 · 每 30 秒自动检测`;
  } else {
    const remainingMin = estimateSyncRemainingMinutes(elapsedMs);
    el.textContent = `同步进行中 · ${period.start} ~ ${period.end} · 已等待 ${mins}:${String(secs).padStart(2, "0")} · 预计还需约 ${remainingMin} 分钟`;
  }
  el.classList.remove("hidden");
}

function isPatMissingPayload(payload, status) {
  return payload?.code === "pat_missing" || (status === 503 && /GITHUB_PAT|pat_missing|尚未配置/i.test(payload?.error || ""));
}

function patSetupMessage(payload) {
  return (
    payload?.setup ||
    "在 Netlify 站点 bluetti-edm-dashboard 的环境变量中添加 GITHUB_PAT（Classic PAT，勾选 repo + workflow），设置后重新选择日期即可。"
  );
}

async function triggerRemoteSync(start, end) {
  const url = `${TRIGGER_SYNC_URL}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const res = await fetch(url, { method: "POST", cache: "no-store" });
  let payload = {};
  try {
    payload = await res.json();
  } catch (_) {
    payload = {};
  }
  if (payload.alreadyExists) {
    return payload;
  }
  if (!res.ok || !payload.triggered) {
    if (isPatMissingPayload(payload, res.status)) {
      const err = new Error(payload.error || "后台同步尚未配置");
      err.code = "pat_missing";
      err.setup = patSetupMessage(payload);
      throw err;
    }
    const msg = payload.error || payload.detail || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload;
}

async function ensureCustomSyncTriggered(period) {
  const key = `${period.start}_${period.end}`;
  if (syncTriggeredKey === key) return { triggered: true, already: true };
  const result = await triggerRemoteSync(period.start, period.end);
  if (result.alreadyExists) {
    syncTriggeredKey = key;
    return result;
  }
  syncTriggeredKey = key;
  return result;
}

async function probeCustomData(period) {
  const url = dataUrlForPeriod(period);
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch (_) {
    /* ignore */
  }
  return null;
}

function startCustomSyncPolling(period, { autoTriggered = false, silent = false } = {}) {
  stopCustomPolling();
  customPollPeriod = { ...period };
  customPollStartedAt = Date.now();
  if (!silent) {
    showCustomEmpty(period, { polling: true, autoTriggered });
  }

  const tick = async () => {
    const elapsed = Date.now() - customPollStartedAt;
    if (!silent) {
      updateCustomPollStatus(period, elapsed, { syncing: autoTriggered });
    }
    if (elapsed > CUSTOM_POLL_MAX_MS) {
      stopCustomPolling();
      if (!silent) {
        const el = $("#custom-poll-status");
        if (el) {
          el.textContent =
            "等待超时。数据可能仍在 GitHub Actions 中生成，请稍后再选同一日期范围，或使用下方「重试同步」。";
        }
        const retryBtn = $("#custom-auto-sync");
        if (retryBtn) {
          retryBtn.disabled = false;
          retryBtn.textContent = "重试同步";
        }
      }
      return;
    }
    const data = await probeCustomData(period);
    if (data) {
      const ready = !comparisonsMissingForPeriod(period, data);
      if (!ready && elapsed < CUSTOM_POLL_MAX_MS) return;
      stopCustomPolling();
      if (silent) {
        await applyPeriod(period, { silent: true, replaceHistory: true });
      } else {
        DATA = data;
        hideCustomEmpty();
        $("#loading").classList.add("hidden");
        refreshAllViews();
        showSection($("#section-select").value);
        showPeriodNotice(
          ready
            ? `自定义范围 ${period.start} ~ ${period.end} 已同步并自动加载。`
            : `自定义范围 ${period.start} ~ ${period.end} 已加载，同比/环比数据仍在同步中…`,
          false
        );
      }
    }
  };

  tick();
  customPollTimer = setInterval(tick, CUSTOM_POLL_INTERVAL_MS);
}

async function beginCustomAutoSync(period, { silent = false, force = false } = {}) {
  const existing = await probeCustomData(period);
  if (existing && !force && !shouldTriggerCustomSync(period, existing)) {
    if (!silent) {
      hideCustomEmpty();
      showPeriodNotice(`自定义范围 ${period.start} ~ ${period.end} 已缓存，即时加载。`, false);
    }
    return { skipped: true, reason: "data_ready" };
  }

  if (existing && !comparisonsMissingForPeriod(period, existing) && dataIsFresh(existing) && !force) {
    if (!silent) {
      hideCustomEmpty();
      showPeriodNotice(`自定义范围 ${period.start} ~ ${period.end} 已就绪。`, false);
    }
    return { skipped: true, reason: "data_ready" };
  }

  if (!silent) {
    showCustomEmpty(period, { polling: true, autoTriggered: true, pending: true });
    showPeriodNotice(`正在后台同步 ${period.start} ~ ${period.end}…`, false);
  }
  try {
    const result = await ensureCustomSyncTriggered(period);
    if (result.alreadyExists && result.complete) {
      syncTriggeredKey = null;
      if (!silent) {
        hideCustomEmpty();
        showPeriodNotice(`自定义范围 ${period.start} ~ ${period.end} 数据已在站点上。`, false);
      }
      await applyPeriod(period, { silent: true, replaceHistory: true });
      return result;
    }
    if (result.alreadyExists && !result.complete) {
      syncTriggeredKey = null;
      if (!silent) {
        showPeriodNotice(
          `自定义范围 ${period.start} ~ ${period.end} 已加载，同比/环比数据尚不完整。`,
          false
        );
      }
      return result;
    }
    startCustomSyncPolling(period, { autoTriggered: true, silent });
    if (silent) {
      showPeriodNotice(
        `自定义范围 ${period.start} ~ ${period.end} 正在后台同步，就绪后将自动切换。`,
        false
      );
    }
  } catch (err) {
    syncTriggeredKey = null;
    if (err.code === "pat_missing") {
      const setup = err.setup || patSetupMessage({});
      if (silent) {
        showPeriodNotice(`后台同步尚未配置：${setup}`, true);
      } else {
        showCustomEmpty(period, { polling: false, syncError: setup, patMissing: true });
        showPeriodNotice("后台同步需要一次性配置 GITHUB_PAT，详见下方说明。", true);
      }
      return;
    }
    if (silent) {
      showPeriodNotice(`自定义范围同步未能启动：${err.message}`, true);
    } else {
      showCustomEmpty(period, { polling: false, syncError: err.message });
      showPeriodNotice(
        `无法自动触发同步：${err.message}。可点击「重试同步」，或稍后再试（上月 / 本月至今每日自动更新）。`,
        true
      );
    }
  }
}

function syncUrlPeriod(period, { replace = true } = {}) {
  const url = new URL(location.href);
  if (period.preset === "custom" && period.start && period.end) {
    url.searchParams.set("start", period.start);
    url.searchParams.set("end", period.end);
    url.searchParams.delete("period");
  } else if (period.preset && PRESET_DAYS[period.preset]) {
    url.searchParams.set("period", period.preset);
    url.searchParams.delete("start");
    url.searchParams.delete("end");
  } else {
    return;
  }
  const state = { period };
  if (replace) {
    history.replaceState(state, "", url);
  } else {
    history.pushState(state, "", url);
  }
}

function hideAllViews() {
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
}

function hideCustomEmpty() {
  stopCustomPolling();
  $("#custom-empty")?.classList.add("hidden");
  $("#custom-poll-status")?.classList.add("hidden");
}

function showCustomEmpty(period, { polling = false, autoTriggered = false, pending = false, syncError = null, patMissing = false } = {}) {
  hideAllViews();
  $("#error")?.classList.add("hidden");
  const el = $("#custom-empty");
  if (!el) return;
  $("#custom-empty-range").textContent = `${period.start} ~ ${period.end}`;
  const link = $("#custom-sync-link");
  if (link) link.href = workflowDispatchUrl(period.start, period.end);
  const autoBtn = $("#custom-auto-sync");
  if (autoBtn) {
    autoBtn.disabled = polling && !syncError;
    if (pending) {
      autoBtn.textContent = "正在触发同步…";
    } else if (polling) {
      autoBtn.textContent = "同步中…";
    } else {
      autoBtn.textContent = syncError ? "重试同步" : "重试同步";
    }
    if (!autoBtn.dataset.bound) {
      autoBtn.dataset.bound = "1";
      autoBtn.addEventListener("click", () => {
        if (currentPeriod.preset !== "custom" || !currentPeriod.start || !currentPeriod.end) return;
        syncTriggeredKey = null;
        comparisonResyncKey = null;
        beginCustomAutoSync(currentPeriod);
      });
    }
  }
  const hint = $("#custom-empty-hint");
  if (hint) {
    if (patMissing) {
      hint.textContent = syncError || patSetupMessage({});
    } else if (syncError) {
      hint.textContent = `自动同步失败：${syncError}。点击「重试同步」再试一次；GitHub 链接仅供排查。`;
    } else if (polling || autoTriggered) {
      hint.textContent =
        `首次选择该区间，正在后台拉取数据（约 ${SYNC_ETA_MINUTES} 分钟），请稍候。缓存命中后再次选择同一区间将即时展示（<1 秒）。`;
    } else {
      hint.textContent =
        "选择自定义日期后会自动触发后台同步。预设区间（7 / 30 / 60 / 90 天）及上月、本月至今每日自动更新。";
    }
  }
  el.classList.toggle("syncing", polling);
  if (!polling) {
    $("#custom-poll-status")?.classList.add("hidden");
  }
  el.classList.remove("hidden");
}

function customMissingNotice(period) {
  return `自定义范围 <strong>${period.start} ~ ${period.end}</strong> 首次选择，正在后台拉取数据（约 ${SYNC_ETA_MINUTES} 分钟）…`;
}

function showPeriodNotice(message, isError = false) {
  const el = $("#period-notice");
  if (!el) return;
  if (!message) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
  el.innerHTML = message;
}

async function loadData(period) {
  const primary = dataUrlForPeriod(period);
  // Only 30d may fall back to dashboard.json (legacy default). Other presets must load their own file.
  const urls =
    period.preset === "30d" ? [...new Set(["data/dashboard.json", primary])] : [primary];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastErr = new Error(`无法加载 ${url} (${res.status})`);
        continue;
      }
      return { data: await res.json(), url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("无法加载看板数据");
}

function renderMeta() {
  const m = DATA.meta;
  const p = normalizePeriod(m.period);
  const seed = m.seed ? " · 快照预览" : "";
  const errs = m.errors?.length ? ` · ${m.errors.length} 站同步失败` : "";
  const range =
    p.start && p.end ? ` · ${p.start} ~ ${p.end}` : "";
  $("#meta-line").textContent =
    `数据区间：${p.label || periodLabel(p)}${range} · 更新 ${m.updatedAt.replace("T", " ").replace("Z", " UTC")} · ${m.siteCount} 站${seed}${errs}`;
}

function renderKpis() {
  const agg = aggregateView(metricView);
  const viewLabel = metricView === "combined" ? "合计" : metricView === "campaign" ? "Campaign" : "Flow";
  $("#kpi-grid").innerHTML = [
    { label: `${viewLabel} GMV (CNY)`, value: cny(agg.gmvCny), cls: "info" },
    { label: "Campaign 占比", value: pct(agg.campaignShare), cls: "", hide: metricView === "flow" },
    { label: "Flow 占比", value: pct(agg.flowShare), cls: "success", hide: metricView === "campaign" },
    { label: "打开率", value: pct(agg.openRate), cls: "" },
    { label: "点击率", value: pct(agg.clickRate, 2), cls: "" },
    { label: "转化率", value: pct(agg.convRate, 2), cls: "" },
  ]
    .filter((k) => !k.hide)
    .map(
      (k) => `
    <div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value ${k.cls}">${k.value}</div>
    </div>`
    )
    .join("");
}

function renderCharts() {
  const agg = aggregateView(metricView);
  const pieCtx = $("#pie-chart");
  if (pieChart) pieChart.destroy();

  if (metricView === "combined") {
    pieChart = new Chart(pieCtx, {
      type: "doughnut",
      data: {
        labels: ["Campaign", "Flow"],
        datasets: [{ data: [agg.campaignCny, agg.flowCny], backgroundColor: ["#3b82f6", "#22c55e"], borderWidth: 0 }],
      },
      options: { plugins: { legend: { display: false } }, cutout: "55%" },
    });
    $("#pie-legend").innerHTML = `
      <div class="total">合计 ${cny(agg.gmvCny)}</div>
      <div class="legend-item"><span class="legend-dot" style="background:#3b82f6"></span>Campaign ${cny(agg.campaignCny)} (${pct(agg.campaignShare)})</div>
      <div class="legend-item"><span class="legend-dot" style="background:#22c55e"></span>Flow ${cny(agg.flowCny)} (${pct(agg.flowShare)})</div>`;
  } else {
    const label = metricView === "campaign" ? "Campaign" : "Flow";
    const val = metricView === "campaign" ? agg.campaignCny : agg.flowCny;
    pieChart = new Chart(pieCtx, {
      type: "doughnut",
      data: {
        labels: [label],
        datasets: [{ data: [val], backgroundColor: [metricView === "campaign" ? "#3b82f6" : "#22c55e"], borderWidth: 0 }],
      },
      options: { plugins: { legend: { display: false } }, cutout: "55%" },
    });
    $("#pie-legend").innerHTML = `<div class="total">${label} ${cny(val)}</div>`;
  }

  const rows = DATA.rows.slice().sort((a, b) => viewGmv(b, metricView).cny - viewGmv(a, metricView).cny);
  const barCtx = $("#bar-chart");
  if (barChart) barChart.destroy();

  const chartTitle = $("#bar-chart-title");
  if (chartTitle) chartTitle.textContent = metricView === "combined" ? "各站 GMV（本位币 / CNY）" : `各站 ${metricView === "campaign" ? "Campaign" : "Flow"} GMV（CNY）`;

  if (metricView === "combined") {
    barChart = new Chart(barCtx, {
      type: "bar",
      data: {
        labels: rows.map((r) => r.region),
        datasets: [
          { label: "Campaign CNY", data: rows.map((r) => r.campaignGmvCny), backgroundColor: "#3b82f6" },
          { label: "Flow CNY", data: rows.map((r) => r.flowGmvCny), backgroundColor: "#22c55e" },
        ],
      },
      options: chartOptions(),
    });
  } else {
    const key = metricView === "campaign" ? "campaignGmvCny" : "flowGmvCny";
    barChart = new Chart(barCtx, {
      type: "bar",
      data: {
        labels: rows.map((r) => r.region),
        datasets: [{ label: "GMV CNY", data: rows.map((r) => r[key]), backgroundColor: metricView === "campaign" ? "#3b82f6" : "#22c55e" }],
      },
      options: chartOptions(),
    });
  }
}

function chartOptions() {
  return {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { stacked: metricView === "combined", ticks: { callback: (v) => cny(v) }, grid: { color: "#2d3a4f" } },
      y: { stacked: metricView === "combined", grid: { display: false } },
    },
    plugins: { legend: { position: "bottom", labels: { color: "#8b9cb3" } } },
  };
}

function renderOverviewTable() {
  const agg = aggregateView(metricView);
  const totalGmv = agg.gmvCny;
  const tbody = $("#overview-table tbody");
  const showCamp = metricView !== "flow";
  const showFlow = metricView !== "campaign";

  $("#overview-table thead tr").innerHTML = `
    <th class="col-site">站点</th>
    ${showCamp ? '<th class="col-num">Campaign GMV</th>' : ""}
    ${showFlow ? '<th class="col-num">Flow GMV</th>' : ""}
    <th class="col-num">合计 GMV</th>
    <th class="col-num">打开率</th>
    <th class="col-num">转化率</th>
    <th class="col-num">占比</th>`;

  tbody.innerHTML = DATA.rows
    .map((row) => {
      const m = pickMetrics(row, metricView);
      const g = viewGmv(row, metricView);
      const cells = [
        `<td class="col-site">${row.region}</td>`,
        showCamp
          ? `<td class="col-num dual">${dualGmv(g.campLocal, row.currency, g.campCny)}</td>`
          : "",
        showFlow ? `<td class="col-num dual">${dualGmv(g.flowLocal, row.currency, g.flowCny)}</td>` : "",
        `<td class="col-num dual"><strong>${dualGmv(g.local, row.currency, g.cny)}</strong></td>`,
        `<td class="col-num">${pct(m.openRate)}</td>`,
        `<td class="col-num">${pct(m.convRate, 2)}</td>`,
        `<td class="col-num">${pct(g.cny / totalGmv, 1)}</td>`,
      ].join("");
      return `<tr class="${rowTone(row, totalGmv, metricView)}">${cells}</tr>`;
    })
    .join("");
}

function renderEmailList(items, kind, region, type = "campaign") {
  if (!items?.length) return `<p class="hint">暂无数据</p>`;
  return items
    .map((item) => {
      const m = item.metrics || {};
      const metricsLine = m.recipients
        ? `<div class="email-metrics">发送 ${m.recipients.toLocaleString()} · 打开 ${pct(m.openRate)} · 点击 ${pct(m.clickRate, 2)} · GMV ${Math.round(m.gmv || 0).toLocaleString()}</div>`
        : "";
      const title =
        type === "flow" && region
          ? `<div class="email-name">${flowLink(region, item.name, item.name)}</div>`
          : `<div class="email-name">${escapeHtml(item.name)}</div>`;
      const insightRow =
        type === "flow" && region && getFlowInsight(region, item.name)
          ? `<button type="button" class="insight-btn inline" data-flow-id="${escapeHtml(flowInsightId(region, item.name))}">查看完整洞察</button>`
          : "";
      return `
      <div class="email-card ${kind}">
        ${title}
        <div class="email-subject">Subject：${escapeHtml(item.subject || "—")}</div>
        <div class="email-audience">受众：${escapeHtml(item.audience || "—")}</div>
        ${metricsLine}
        <ul class="email-reasons">${(item.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
        ${insightRow}
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FLOW_PRIORITY_ORDER = ["P0", "P1", "P2"];
const FLOW_PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };
let flowFilterHandlersBound = false;

function normalizePriority(priority) {
  if (priority == null || priority === "") return "";
  const raw = String(priority).trim().toUpperCase();
  if (FLOW_PRIORITY_ORDER.includes(raw)) return raw;
  const match = raw.match(/^P?(\d)$/);
  if (match) return `P${match[1]}`;
  return raw;
}

function uniqueFlowRegions(extraItems = []) {
  const seen = new Set();
  const out = [];
  const push = (code) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push(code);
  };
  for (const code of DATA.siteOrder || DATA.rows?.map((r) => r.region) || []) push(code);
  for (const item of extraItems) push(typeof item === "string" ? item : item?.region);
  return out;
}

function collectFlowPriorities(alerts) {
  const found = new Set((alerts || []).map((a) => normalizePriority(a.priority)).filter(Boolean));
  return FLOW_PRIORITY_ORDER.filter((p) => found.has(p));
}

function populateSelectOptions(select, options, currentValue, allLabel) {
  if (!select) return;
  const current = currentValue || select.value || "ALL";
  select.innerHTML = `<option value="ALL">${allLabel}</option>${options
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("")}`;
  if ([...select.options].some((o) => o.value === current)) select.value = current;
  else select.value = "ALL";
}

function getFlowIndexItems() {
  if (DATA.flowIndex?.length) return DATA.flowIndex;
  const insights = DATA.flowInsights || {};
  return Object.values(insights);
}

function bindFlowFilterHandlers() {
  if (flowFilterHandlersBound) return;
  flowFilterHandlersBound = true;
  $("#flow-alert-region")?.addEventListener("change", renderFlow);
  $("#flow-alert-priority")?.addEventListener("change", renderFlow);
  $("#flow-insight-region")?.addEventListener("change", renderFlowInsights);
  $("#flow-insight-tag")?.addEventListener("change", renderFlowInsights);
}

function flowInsightId(region, name) {
  return `${region}::${name}`;
}

function getFlowInsight(region, name) {
  const map = DATA.flowInsights || {};
  return map[flowInsightId(region, name)] || null;
}

function flowLink(region, name, label) {
  const id = flowInsightId(region, name);
  const has = (DATA.flowInsights || {})[id];
  if (!has) return escapeHtml(label || name);
  return `<button type="button" class="flow-link" data-flow-id="${escapeHtml(id)}">${escapeHtml(label || name)}</button>`;
}

function insightBtn(region, name) {
  const id = flowInsightId(region, name);
  if (!(DATA.flowInsights || {})[id]) return "—";
  return `<button type="button" class="insight-btn" data-flow-id="${escapeHtml(id)}">查看</button>`;
}

function renderFlowTags(tags) {
  const labels = { best: "优秀", improve: "待优化", alert: "待关注" };
  if (!tags?.length) return '<span class="tag tag-neutral">常规</span>';
  return tags.map((t) => `<span class="tag tag-${t}">${labels[t] || t}</span>`).join(" ");
}

function renderInsightDrawer(item) {
  if (!item) return;
  $("#insight-drawer-region").textContent = item.region;
  $("#insight-drawer-title").textContent = item.name;
  $("#insight-drawer-status").textContent = `${item.status.toUpperCase()} · ${item.summary} · ${periodLabel(DATA.meta?.period)}`;
  const m = item.metrics;
  const alertBlock =
    item.alerts?.length > 0
      ? `<div class="drawer-section">
        <h3>待关注</h3>
        <ul class="drawer-list alert-list">${item.alerts
          .map(
            (a) => `<li><strong>${escapeHtml(a.priority)} · ${escapeHtml(a.category)}</strong><br>${escapeHtml(a.issue)}<br><em>${escapeHtml(a.action)}</em></li>`
          )
          .join("")}</ul>
      </div>`
      : "";
  $("#insight-drawer-body").innerHTML = `
    <div class="drawer-metrics">
      <div><span>发送量</span><strong>${m.recipients.toLocaleString()}</strong></div>
      <div><span>打开率</span><strong>${pct(m.openRate)}</strong></div>
      <div><span>点击率</span><strong>${pct(m.clickRate, 2)}</strong></div>
      <div><span>转化率</span><strong>${pct(m.convRate, 2)}</strong></div>
      <div><span>GMV</span><strong>${escapeHtml(m.gmvLabel)}</strong></div>
    </div>
    <div class="drawer-section">
      <h3>做得好的地方</h3>
      <ul class="drawer-list good-list">${(item.strengths?.length ? item.strengths : ["暂无突出亮点"]).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
    </div>
    <div class="drawer-section">
      <h3>可以改进的地方</h3>
      <ul class="drawer-list improve-list">${(item.improvements?.length ? item.improvements : ["暂无明确改进项"]).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
    </div>
    ${alertBlock}`;
}

function openInsightDrawer(id) {
  const item = (DATA.flowInsights || {})[id];
  if (!item) return;
  renderInsightDrawer(item);
  $("#insight-drawer").classList.remove("hidden");
  $("#insight-backdrop").classList.remove("hidden");
  $("#insight-drawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeInsightDrawer() {
  $("#insight-drawer").classList.add("hidden");
  $("#insight-backdrop").classList.add("hidden");
  $("#insight-drawer").setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
}

function bindFlowInsightClicks(root) {
  (root || document).querySelectorAll("[data-flow-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openInsightDrawer(el.getAttribute("data-flow-id"));
    });
  });
}

function renderSites() {
  const container = $("#sites-container");
  const order = DATA.siteOrder || DATA.rows.map((r) => r.region);
  container.innerHTML = order
    .map((code) => {
      const why = DATA.siteWhy[code];
      if (!why) return "";
      return `
      <div class="site-block" data-site="${code}">
        <button type="button" class="site-header" aria-expanded="false">
          <span>${code}</span>
          <span class="chevron">›</span>
        </button>
        <div class="site-body">
          <p class="site-summary">${escapeHtml(why.summary || "")}</p>
          <div class="sub-block open">
            <button type="button" class="sub-header">Campaign 最佳 / 待优化 <span class="chevron">›</span></button>
            <div class="sub-body">
              <p class="hint">最佳</p>
              ${renderEmailList(why.campaignBest, "best", code, "campaign")}
              <p class="hint" style="margin-top:0.75rem">待优化</p>
              ${renderEmailList(why.campaignWorst, "worst", code, "campaign")}
            </div>
          </div>
          <div class="sub-block open">
            <button type="button" class="sub-header">Flow 最佳 / 待优化 <span class="chevron">›</span></button>
            <div class="sub-body">
              <p class="hint">最佳 · 点击名称查看完整洞察</p>
              ${renderEmailList(why.flowBest, "best", code, "flow")}
              <p class="hint" style="margin-top:0.75rem">待优化</p>
              ${renderEmailList(why.flowWorst, "worst", code, "flow")}
            </div>
          </div>
        </div>
      </div>`;
    })
    .join("");

  container.querySelectorAll(".site-header").forEach((btn) => {
    btn.addEventListener("click", () => {
      const block = btn.closest(".site-block");
      block.classList.toggle("open");
      btn.setAttribute("aria-expanded", block.classList.contains("open"));
    });
  });
  container.querySelectorAll(".sub-header").forEach((btn) => {
    btn.addEventListener("click", () => btn.closest(".sub-block").classList.toggle("open"));
  });
  bindFlowInsightClicks(container);
}

function renderFlow() {
  const regionFilter = $("#flow-alert-region")?.value || "ALL";
  const priorityFilter = $("#flow-alert-priority")?.value || "ALL";
  let alerts = (DATA.flowAlerts || []).map((a) => ({ ...a, priority: normalizePriority(a.priority) || a.priority }));
  if (regionFilter !== "ALL") alerts = alerts.filter((a) => a.region === regionFilter);
  if (priorityFilter !== "ALL") alerts = alerts.filter((a) => a.priority === priorityFilter);
  alerts.sort(
    (a, b) =>
      (FLOW_PRIORITY_RANK[a.priority] ?? 99) - (FLOW_PRIORITY_RANK[b.priority] ?? 99) ||
      String(a.region).localeCompare(String(b.region))
  );

  const tbody = $("#flow-table tbody");
  tbody.innerHTML = alerts.length
    ? alerts
        .map(
          (a) => `<tr class="${alertTone(a.priority)}">
      <td>${a.priority}</td>
      <td>${a.region}</td>
      <td>${flowLink(a.region, a.flow, a.flow)}</td>
      <td>${a.category}</td>
      <td>${escapeHtml(a.issue)}</td>
      <td>${escapeHtml(a.action)}</td>
      <td class="col-action">${insightBtn(a.region, a.flow)}</td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="hint">暂无匹配的待关注项</td></tr>`;
  bindFlowInsightClicks($("#flow-table"));
}

function setupFlowAlertFilters() {
  const alerts = DATA.flowAlerts || [];
  populateSelectOptions($("#flow-alert-region"), uniqueFlowRegions(alerts), null, "全部站点");
  populateSelectOptions($("#flow-alert-priority"), collectFlowPriorities(alerts), null, "全部");
}

function renderFlowInsights() {
  const regionFilter = $("#flow-insight-region")?.value || "ALL";
  const tagFilter = $("#flow-insight-tag")?.value || "ALL";
  let items = getFlowIndexItems();
  if (regionFilter !== "ALL") items = items.filter((x) => x.region === regionFilter);
  if (tagFilter !== "ALL") items = items.filter((x) => (x.tags || []).includes(tagFilter));

  const tbody = $("#flow-insight-table tbody");
  if (!tbody) return;
  tbody.innerHTML = items.length
    ? items
        .map((item) => {
          const m = item.metrics || {};
          return `<tr>
        <td class="col-site">${escapeHtml(item.region || "—")}</td>
        <td>${flowLink(item.region, item.name, item.name)}</td>
        <td>${escapeHtml(item.status || "—")}</td>
        <td class="col-num">${escapeHtml(m.gmvLabel || "—")}</td>
        <td class="col-num">${pct(m.openRate || 0)}</td>
        <td class="col-num">${pct(m.convRate || 0, 2)}</td>
        <td>${renderFlowTags(item.tags)}</td>
        <td class="col-action">${insightBtn(item.region, item.name)}</td>
      </tr>`;
        })
        .join("")
    : `<tr><td colspan="8" class="hint">暂无匹配的 Flow</td></tr>`;
  bindFlowInsightClicks($("#flow-insight-table"));
}

function setupFlowInsightFilters() {
  populateSelectOptions($("#flow-insight-region"), uniqueFlowRegions(getFlowIndexItems()), null, "全部站点");
}

function renderPlaybookEntry(item, regionCode) {
  if (!item || typeof item === "string") {
    return `<li class="playbook-legacy">${escapeHtml(String(item))}</li>`;
  }
  const verdictClass = item.verdict === "copy" ? "verdict-copy" : "verdict-avoid";
  const verdictLabel = item.verdict === "copy" ? "可复制" : "待避免";
  const m = item.metrics || {};
  const meta =
    item.type === "campaign" && item.subject && item.subject !== "—"
      ? `<p class="playbook-meta">Subject：${escapeHtml(item.subject)}</p>`
      : "";
  const audience =
    item.type === "campaign" && item.audience && item.audience !== "—"
      ? `<p class="playbook-meta">受众：${escapeHtml(item.audience)}</p>`
      : "";
  const benchmark = item.benchmark || {};
  const comparisons = (benchmark.comparisons || [])
    .map((x) => `<li>${escapeHtml(x)}</li>`)
    .join("");
  const flowInsightBtn =
    item.type === "flow" && getFlowInsight(regionCode, item.name)
      ? `<button type="button" class="insight-btn inline" data-flow-id="${escapeHtml(flowInsightId(regionCode, item.name))}">查看 Flow 洞察</button>`
      : "";
  return `
    <details class="playbook-entry ${verdictClass}">
      <summary class="playbook-entry-summary">
        <span class="playbook-type">${item.type === "campaign" ? "Campaign" : "Flow"}</span>
        <span class="playbook-name">${item.type === "flow" ? flowLink(regionCode, item.name, item.name) : escapeHtml(item.name)}</span>
        <span class="playbook-verdict">${verdictLabel}</span>
      </summary>
      <div class="playbook-entry-body">
        <p class="playbook-source">${escapeHtml(item.dataSource || "Klaviyo 近30天 Placed Order")}</p>
        ${meta}
        ${audience}
        <div class="playbook-metrics">
          <div><span>发送量</span><strong>${(m.recipients || 0).toLocaleString()}</strong></div>
          <div><span>打开率</span><strong>${pct(m.openRate || 0)}</strong></div>
          <div><span>点击率</span><strong>${pct(m.clickRate || 0, 2)}</strong></div>
          <div><span>转化率</span><strong>${pct(m.convRate || 0, 2)}</strong></div>
          <div><span>GMV</span><strong>${escapeHtml(m.gmvLabel || String(m.gmv || 0))}</strong></div>
        </div>
        <h5 class="playbook-subhead">因果链</h5>
        <ol class="logic-chain">${(item.logicChain || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>
        ${
          benchmark.summary
            ? `<div class="playbook-benchmark">
          <h5 class="playbook-subhead">站点对比</h5>
          <p class="benchmark-summary">${escapeHtml(benchmark.summary)}</p>
          ${comparisons ? `<ul class="benchmark-deltas">${comparisons}</ul>` : ""}
        </div>`
            : ""
        }
        <p class="playbook-action"><strong>下一步：</strong>${escapeHtml(item.action || "—")}</p>
        ${flowInsightBtn}
      </div>
    </details>`;
}

function renderPlaybookSection(title, items, regionCode) {
  if (!items?.length) {
    return `<div class="playbook-section"><h4>${title}</h4><p class="hint">暂无足够数据</p></div>`;
  }
  const body = items
    .map((item) => (typeof item === "string" ? renderPlaybookEntry(item, regionCode) : renderPlaybookEntry(item, regionCode)))
    .join("");
  return `<div class="playbook-section"><h4>${title}</h4><div class="playbook-entries">${body}</div></div>`;
}

function renderPlaybook() {
  const order = DATA.siteOrder || DATA.rows.map((r) => r.region);
  const playbooks = DATA.sitePlaybook || {};
  $("#playbook-grid").innerHTML = order
    .map((code) => {
      const pb = playbooks[code];
      if (!pb) return "";
      return `
      <div class="card playbook-card site-playbook">
        <h3>${code} · Playbook</h3>
        <p class="site-summary">${escapeHtml(pb.summary || "")}</p>
        ${renderPlaybookSection("Campaign 可复制", pb.successCampaign, code)}
        ${renderPlaybookSection("Campaign 待避免", pb.avoidCampaign, code)}
        ${renderPlaybookSection("Flow 可复制", pb.successFlow, code)}
        ${renderPlaybookSection("Flow 待避免", pb.avoidFlow, code)}
      </div>`;
    })
    .join("");
  bindFlowInsightClicks($("#playbook-grid"));
}

const COMPARISON_CONV_KEYS = new Set(["gmvCny", "gmvLocal", "campaignCny", "flowCny", "campaignShare", "flowShare", "convRate"]);
const COMPARISON_ENGAGEMENT_KEYS = new Set(["delivered", "campaignDelivered", "flowDelivered", "openRate", "clickRate"]);

function filterComparisonMetrics(metrics, keys) {
  return (metrics || []).filter((m) => keys.has(m.key));
}

function getEngagementBlock(block) {
  if (!block) return null;
  if (block.engagementTotals?.metrics?.length) {
    return {
      totals: block.engagementTotals,
      campaign: block.engagementCampaign || block.campaign,
      flow: block.engagementFlow || block.flow,
    };
  }
  return {
    totals: { metrics: filterComparisonMetrics(block.totals?.metrics, COMPARISON_ENGAGEMENT_KEYS) },
    campaign: { metrics: filterComparisonMetrics(block.campaign?.metrics, COMPARISON_ENGAGEMENT_KEYS) },
    flow: { metrics: filterComparisonMetrics(block.flow?.metrics, COMPARISON_ENGAGEMENT_KEYS) },
  };
}

function getConvBlock(block) {
  if (!block) return null;
  return {
    totals: { metrics: filterComparisonMetrics(block.totals?.metrics, COMPARISON_CONV_KEYS) },
    campaign: { metrics: filterComparisonMetrics(block.campaign?.metrics, COMPARISON_CONV_KEYS) },
    flow: { metrics: filterComparisonMetrics(block.flow?.metrics, COMPARISON_CONV_KEYS) },
  };
}

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return (n ?? 0).toLocaleString();
}

function formatComparisonValue(metric, currency) {
  const v = metric.current;
  if (metric.kind === "count") return formatCount(v);
  if (metric.kind === "rate") return pct(v, metric.key === "convRate" ? 2 : 1);
  if (metric.kind === "cny") return cny(v);
  if (metric.kind === "local") return localGmv(v, currency || "USD");
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

function formatComparisonRef(value, metric, currency) {
  if (value == null) return "—";
  if (metric.kind === "count") return formatCount(value);
  if (metric.kind === "rate") return pct(value, metric.key === "convRate" ? 2 : 1);
  if (metric.kind === "cny") return cny(value);
  if (metric.kind === "local") return localGmv(value, currency || "USD");
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

function deltaClass(metric, pctVal) {
  if (pctVal == null || Number.isNaN(pctVal)) return "delta-neutral";
  if (pctVal === 0) return "delta-neutral";
  const up = pctVal > 0;
  const good = metric.higherIsBetter ? up : !up;
  return good ? "delta-up" : "delta-down";
}

function renderDeltaCell(metric, block) {
  if (!block || block.pct == null) {
    return `<td class="col-num delta-neutral">—</td>`;
  }
  const cls = deltaClass(metric, block.pct);
  const label = block.pctLabel || pct(block.pct);
  return `<td class="col-num ${cls}">${escapeHtml(label)}</td>`;
}

function hasComparisonBlock(comp) {
  const block = normalizeComparisonBlock(getComparisonScopeBlock(comp));
  return Boolean(block?.totals?.metrics?.length);
}

function comparisonsMissingForPeriod(period, data) {
  return period.preset === "custom" && data && !hasComparisonBlock(data.comparisons);
}

function maybeTriggerComparisonResync(period) {
  if (period.preset !== "custom" || !period.start || !period.end) return;
  const key = `cmp_${period.start}_${period.end}`;
  if (comparisonResyncKey === key || customPollTimer) return;
  comparisonResyncKey = key;
  showPeriodNotice(
    `自定义区间 ${period.start} ~ ${period.end} 暂无同比/环比数据。请等待每日自动同步，或联系管理员更新数据文件。`,
    false
  );
}

function comparisonEmptyMessage(period) {
  if (period.preset === "custom" && period.start && period.end) {
    return `自定义区间 ${period.start} ~ ${period.end} 暂无同比/环比数据。可切换至近 30 天查看，或联系管理员更新数据文件。`;
  }
  return "当前数据区间暂无同比环比数据，请等待同步或切换至近 30 天。";
}

function renderComparisonPeriodLabels(comp) {
  const el = $("#comparison-period-labels");
  if (!el || !comp?.meta) return;
  const m = comp.meta;
  const cur = m.current;
  const mom = m.mom;
  const yoy = m.yoy;
  el.innerHTML = [
    `<span><strong>本期</strong> ${escapeHtml(cur?.label || "")} · ${escapeHtml(cur?.start || "")} ~ ${escapeHtml(cur?.end || "")}</span>`,
    mom ? `<span><strong>环比</strong> ${escapeHtml(mom.label || "")} · ${escapeHtml(mom.start)} ~ ${escapeHtml(mom.end)}</span>` : "",
    yoy ? `<span><strong>同比</strong> ${escapeHtml(yoy.label || "")} · ${escapeHtml(yoy.start)} ~ ${escapeHtml(yoy.end)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
}

function getComparisonScopeBlock(comp) {
  if (!comp) return null;
  if (comparisonScope === "sites") {
    return comp.sites?.[comparisonSite] || null;
  }
  return comp.global || null;
}

function normalizeComparisonBlock(block) {
  if (!block) return null;
  if (block.totals?.metrics) return block;
  if (block.metrics) {
    return { totals: { metrics: block.metrics }, campaign: { metrics: [] }, flow: { metrics: [] } };
  }
  return null;
}

function metricByKey(metrics, key) {
  return (metrics || []).find((m) => m.key === key);
}

function periodValues(metric) {
  if (!metric) return { current: 0, mom: 0, yoy: 0 };
  return {
    current: metric.current ?? 0,
    mom: metric.mom?.value ?? 0,
    yoy: metric.yoy?.value ?? 0,
  };
}

function destroyComparisonCharts() {
  if (comparisonGmvChart) {
    comparisonGmvChart.destroy();
    comparisonGmvChart = null;
  }
  if (comparisonRatesChart) {
    comparisonRatesChart.destroy();
    comparisonRatesChart = null;
  }
  if (comparisonDeliveredChart) {
    comparisonDeliveredChart.destroy();
    comparisonDeliveredChart = null;
  }
  if (comparisonEngagementRatesChart) {
    comparisonEngagementRatesChart.destroy();
    comparisonEngagementRatesChart = null;
  }
}

function renderComparisonCharts(block, currency) {
  const gmvCtx = document.getElementById("comparison-gmv-chart");
  const ratesCtx = document.getElementById("comparison-rates-chart");
  if (!gmvCtx || !ratesCtx || typeof Chart === "undefined") return;

  destroyComparisonCharts();

  const totals = block.totals?.metrics || [];
  const campaign = block.campaign?.metrics || [];
  const flow = block.flow?.metrics || [];

  const campGmv = metricByKey(totals, "campaignCny") || metricByKey(campaign, "gmvCny");
  const flowGmv = metricByKey(totals, "flowCny") || metricByKey(flow, "gmvCny");
  const totalGmv = metricByKey(totals, "gmvCny");

  const campG = periodValues(campGmv);
  const flowG = periodValues(flowGmv);
  const totalG = periodValues(totalGmv);

  const chartFont = { family: "system-ui, sans-serif", size: 11 };
  const gridColor = "rgba(128,128,128,0.15)";

  comparisonGmvChart = new Chart(gmvCtx, {
    type: "bar",
    data: {
      labels: ["Campaign GMV", "Flow GMV", "合计 GMV"],
      datasets: [
        {
          label: "本期",
          data: [campG.current, flowG.current, totalG.current],
          backgroundColor: "rgba(59, 130, 246, 0.75)",
          borderRadius: 4,
        },
        {
          label: "环比期",
          data: [campG.mom, flowG.mom, totalG.mom],
          backgroundColor: "rgba(148, 163, 184, 0.7)",
          borderRadius: 4,
        },
        {
          label: "同比期",
          data: [campG.yoy, flowG.yoy, totalG.yoy],
          backgroundColor: "rgba(100, 116, 139, 0.55)",
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { font: chartFont, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${cny(ctx.raw)}`,
          },
        },
      },
      scales: {
        x: { ticks: { font: chartFont }, grid: { display: false } },
        y: {
          ticks: {
            font: chartFont,
            callback: (v) => (v >= 1e6 ? `¥${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `¥${Math.round(v / 1e3)}K` : `¥${v}`),
          },
          grid: { color: gridColor },
        },
      },
    },
  });

  const rateKeys = [
    { key: "convRate", label: "Campaign 转化率" },
    { key: "convRate", label: "Flow 转化率", flow: true },
  ];

  const currentRates = rateKeys.map(({ key, flow: isFlow }) => {
    const m = metricByKey(isFlow ? flow : campaign, key);
    return (m?.current ?? 0) * 100;
  });
  const momRates = rateKeys.map(({ key, flow: isFlow }) => {
    const m = metricByKey(isFlow ? flow : campaign, key);
    return (m?.mom?.value ?? 0) * 100;
  });
  const yoyRates = rateKeys.map(({ key, flow: isFlow }) => {
    const m = metricByKey(isFlow ? flow : campaign, key);
    return (m?.yoy?.value ?? 0) * 100;
  });

  comparisonRatesChart = new Chart(ratesCtx, {
    type: "bar",
    data: {
      labels: rateKeys.map((r) => r.label),
      datasets: [
        {
          label: "本期",
          data: currentRates,
          backgroundColor: "rgba(34, 197, 94, 0.7)",
          borderRadius: 3,
        },
        {
          label: "环比期",
          data: momRates,
          backgroundColor: "rgba(148, 163, 184, 0.65)",
          borderRadius: 3,
        },
        {
          label: "同比期",
          data: yoyRates,
          backgroundColor: "rgba(100, 116, 139, 0.5)",
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { font: chartFont, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toFixed(2)}%`,
          },
        },
      },
      scales: {
        x: { ticks: { font: chartFont, maxRotation: 45, minRotation: 0 }, grid: { display: false } },
        y: {
          ticks: { font: chartFont, callback: (v) => `${v}%` },
          grid: { color: gridColor },
        },
      },
    },
  });
}

function renderComparisonTable(metrics, currency) {
  const tbody = $("#comparison-table tbody");
  if (!tbody) return;
  tbody.innerHTML = (metrics || [])
    .map((metric) => {
      return `<tr>
        <td class="metric-label">${escapeHtml(metric.label)}</td>
        <td class="col-num"><strong>${escapeHtml(formatComparisonValue(metric, currency))}</strong></td>
        <td class="col-num">${escapeHtml(formatComparisonRef(metric.mom?.value, metric, currency))}</td>
        ${renderDeltaCell(metric, metric.mom)}
        <td class="col-num">${escapeHtml(formatComparisonRef(metric.yoy?.value, metric, currency))}</td>
        ${renderDeltaCell(metric, metric.yoy)}
      </tr>`;
    })
    .join("");
}

function renderComparisonTableSections(block, currency, tbodySel = "#comparison-table tbody") {
  const tbody = $(tbodySel);
  if (!tbody) return;
  const totalsTitle = comparisonScope === "sites" ? "站点合计" : "全球合计";
  const sections = [
    { title: totalsTitle, metrics: block.totals?.metrics || [] },
    { title: "Campaign（单次群发）", metrics: block.campaign?.metrics || [] },
    { title: "Flow（自动化）", metrics: block.flow?.metrics || [] },
  ];
  const rows = [];
  sections.forEach((sec) => {
    if (!sec.metrics.length) return;
    rows.push(`<tr class="section-header"><td colspan="6">${escapeHtml(sec.title)}</td></tr>`);
    sec.metrics.forEach((metric) => {
      rows.push(`<tr>
        <td class="metric-label">${escapeHtml(metric.label)}</td>
        <td class="col-num"><strong>${escapeHtml(formatComparisonValue(metric, currency))}</strong></td>
        <td class="col-num">${escapeHtml(formatComparisonRef(metric.mom?.value, metric, currency))}</td>
        ${renderDeltaCell(metric, metric.mom)}
        <td class="col-num">${escapeHtml(formatComparisonRef(metric.yoy?.value, metric, currency))}</td>
        ${renderDeltaCell(metric, metric.yoy)}
      </tr>`);
    });
  });
  tbody.innerHTML = rows.join("");
}

function renderEngagementCharts(engBlock) {
  const deliveredCtx = document.getElementById("comparison-delivered-chart");
  const ratesCtx = document.getElementById("comparison-engagement-rates-chart");
  if (!deliveredCtx || !ratesCtx || typeof Chart === "undefined") return;

  if (comparisonDeliveredChart) {
    comparisonDeliveredChart.destroy();
    comparisonDeliveredChart = null;
  }
  if (comparisonEngagementRatesChart) {
    comparisonEngagementRatesChart.destroy();
    comparisonEngagementRatesChart = null;
  }

  const totals = engBlock.totals?.metrics || [];
  const campaign = engBlock.campaign?.metrics || [];
  const flow = engBlock.flow?.metrics || [];

  const campD = metricByKey(totals, "campaignDelivered") || metricByKey(campaign, "delivered");
  const flowD = metricByKey(totals, "flowDelivered") || metricByKey(flow, "delivered");
  const totalD = metricByKey(totals, "delivered");

  const campDel = periodValues(campD);
  const flowDel = periodValues(flowD);
  const totalDel = periodValues(totalD);

  const chartFont = { family: "system-ui, sans-serif", size: 11 };
  const gridColor = "rgba(128,128,128,0.15)";

  comparisonDeliveredChart = new Chart(deliveredCtx, {
    type: "bar",
    data: {
      labels: ["Campaign 发送量", "Flow 发送量", "合计发送量"],
      datasets: [
        {
          label: "本期",
          data: [campDel.current, flowDel.current, totalDel.current],
          backgroundColor: "rgba(99, 102, 241, 0.75)",
          borderRadius: 4,
        },
        {
          label: "环比期",
          data: [campDel.mom, flowDel.mom, totalDel.mom],
          backgroundColor: "rgba(148, 163, 184, 0.7)",
          borderRadius: 4,
        },
        {
          label: "同比期",
          data: [campDel.yoy, flowDel.yoy, totalDel.yoy],
          backgroundColor: "rgba(100, 116, 139, 0.55)",
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { font: chartFont, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatCount(ctx.raw)}`,
          },
        },
      },
      scales: {
        x: { ticks: { font: chartFont }, grid: { display: false } },
        y: {
          ticks: {
            font: chartFont,
            callback: (v) => formatCount(v),
          },
          grid: { color: gridColor },
        },
      },
    },
  });

  const rateDefs = [
    { key: "openRate", label: "Campaign 打开率", flow: false },
    { key: "clickRate", label: "Campaign 点击率", flow: false },
    { key: "openRate", label: "Flow 打开率", flow: true },
    { key: "clickRate", label: "Flow 点击率", flow: true },
  ];

  const currentRates = rateDefs.map(({ key, flow: isFlow }) => {
    const m = metricByKey(isFlow ? flow : campaign, key);
    return (m?.current ?? 0) * 100;
  });
  const momRates = rateDefs.map(({ key, flow: isFlow }) => {
    const m = metricByKey(isFlow ? flow : campaign, key);
    return (m?.mom?.value ?? 0) * 100;
  });
  const yoyRates = rateDefs.map(({ key, flow: isFlow }) => {
    const m = metricByKey(isFlow ? flow : campaign, key);
    return (m?.yoy?.value ?? 0) * 100;
  });

  comparisonEngagementRatesChart = new Chart(ratesCtx, {
    type: "bar",
    data: {
      labels: rateDefs.map((r) => r.label),
      datasets: [
        {
          label: "本期",
          data: currentRates,
          backgroundColor: "rgba(14, 165, 233, 0.7)",
          borderRadius: 3,
        },
        {
          label: "环比期",
          data: momRates,
          backgroundColor: "rgba(148, 163, 184, 0.65)",
          borderRadius: 3,
        },
        {
          label: "同比期",
          data: yoyRates,
          backgroundColor: "rgba(100, 116, 139, 0.5)",
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { font: chartFont, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toFixed(2)}%`,
          },
        },
      },
      scales: {
        x: { ticks: { font: chartFont, maxRotation: 45, minRotation: 0 }, grid: { display: false } },
        y: {
          ticks: { font: chartFont, callback: (v) => `${v}%` },
          grid: { color: gridColor },
        },
      },
    },
  });
}

function renderEngagementComparison(block, currency) {
  const engBlock = getEngagementBlock(block);
  const section = $("#comparison-engagement");
  const hasEngagement =
    (engBlock.totals?.metrics?.length || 0) +
      (engBlock.campaign?.metrics?.length || 0) +
      (engBlock.flow?.metrics?.length || 0) >
    0;

  section?.classList.toggle("hidden", !hasEngagement);
  if (!hasEngagement) return;

  renderEngagementCharts(engBlock);
  renderComparisonTableSections(engBlock, currency, "#comparison-engagement-table tbody");
}

function setupComparisonSiteSelect() {
  const select = $("#comparison-site-select");
  if (!select) return;
  const order = DATA.siteOrder || DATA.rows?.map((r) => r.region) || [];
  const sites = DATA.comparisons?.sites || {};
  const options = order.filter((code) => sites[code]);
  select.innerHTML = options
    .map((code) => `<option value="${escapeHtml(code)}">${escapeHtml(code)}</option>`)
    .join("");
  if (options.includes(comparisonSite)) select.value = comparisonSite;
  else {
    comparisonSite = options[0] || "US";
    select.value = comparisonSite;
  }
}

function bindComparisonHandlers() {
  if (comparisonHandlersBound) return;
  comparisonHandlersBound = true;
  document.querySelectorAll(".comparison-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      comparisonScope = btn.dataset.scope || "global";
      document.querySelectorAll(".comparison-tab").forEach((b) => b.classList.toggle("active", b === btn));
      renderComparison();
    });
  });
  $("#comparison-site-select")?.addEventListener("change", (e) => {
    comparisonSite = e.target.value;
    if (DATA.comparisons?.flowYoY?.sites?.[comparisonSite]) {
      flowYoYSite = comparisonSite;
    }
    renderComparison();
  });
}

function renderComparison() {
  bindComparisonHandlers();
  const comp = DATA.comparisons;
  const emptyEl = $("#comparison-empty");
  const tableWrap = $("#comparison-table")?.closest(".card");
  const chartsWrap = $("#comparison-charts");
  const engagementWrap = $("#comparison-engagement");
  const siteFilter = $("#comparison-site-filter-wrap");

  const rawBlock = getComparisonScopeBlock(comp);
  const block = normalizeComparisonBlock(rawBlock);
  const hasData = block?.totals?.metrics?.length;

  if (!hasData) {
    if (emptyEl) {
      emptyEl.textContent = comparisonEmptyMessage(currentPeriod);
      emptyEl.classList.remove("hidden");
    }
    tableWrap?.classList.add("hidden");
    chartsWrap?.classList.add("hidden");
    engagementWrap?.classList.add("hidden");
    siteFilter?.classList.add("hidden");
    $("#comparison-period-labels").innerHTML = "";
    destroyComparisonCharts();
    renderFlowYoYTable();
    return;
  }

  emptyEl?.classList.add("hidden");
  tableWrap?.classList.remove("hidden");
  chartsWrap?.classList.remove("hidden");
  renderComparisonPeriodLabels(comp);

  const isSites = comparisonScope === "sites";
  siteFilter?.classList.toggle("hidden", !isSites);

  let currency = null;
  if (isSites) {
    setupComparisonSiteSelect();
    currency = comp.sites?.[comparisonSite]?.currency;
  }

  renderComparisonCharts(block, currency);
  renderEngagementComparison(block, currency);
  renderComparisonTableSections(getConvBlock(block), currency);
  renderFlowYoYTable();
}

function signedPct(x, digits = 1) {
  if (x == null || Number.isNaN(x)) return "—";
  const sign = x > 0 ? "+" : "";
  return `${sign}${(x * 100).toFixed(digits)}%`;
}

function signedRateDelta(x) {
  if (x == null || Number.isNaN(x)) return "—";
  const sign = x > 0 ? "+" : "";
  return `${sign}${(x * 100).toFixed(2)}pp`;
}

function isWelcomeFlow(name) {
  return /welcome/i.test(name || "");
}

function flowYoYRowClass(row) {
  const deltas = row.deltas || {};
  const convDrop = (deltas.convRateDelta ?? 0) < -0.0005 || (deltas.convRatePct ?? 0) < -0.15;
  const classes = [];
  if (convDrop) classes.push("flow-yoy-drop");
  if (isWelcomeFlow(row.name) && convDrop) classes.push("flow-yoy-welcome-alert");
  return classes.join(" ");
}

function flowYoYSortValue(row, key) {
  const cur = row.current || {};
  const yoy = row.yoy || {};
  const d = row.deltas || {};
  switch (key) {
    case "name":
      return (row.name || "").toLowerCase();
    case "curDelivered":
      return cur.delivered ?? 0;
    case "yoyDelivered":
      return yoy.delivered ?? 0;
    case "deliveredPct":
      return d.deliveredPct ?? -Infinity;
    case "curConvRate":
      return cur.convRate ?? 0;
    case "yoyConvRate":
      return yoy.convRate ?? 0;
    case "convRateDelta":
      return d.convRateDelta ?? -Infinity;
    case "gmvPct":
      return d.gmvPct ?? -Infinity;
    default:
      return 0;
  }
}

function setupFlowYoYSiteSelect() {
  const select = $("#flow-yoy-site-select");
  if (!select) return;
  const flowYoY = DATA.comparisons?.flowYoY;
  const order = DATA.siteOrder || DATA.rows?.map((r) => r.region) || [];
  const sites = flowYoY?.sites || {};
  const options = order.filter((code) => (sites[code] || []).length);
  select.innerHTML = options
    .map((code) => `<option value="${escapeHtml(code)}">${escapeHtml(code)}</option>`)
    .join("");
  const preferred = comparisonScope === "sites" ? comparisonSite : flowYoYSite;
  if (options.includes(preferred)) {
    flowYoYSite = preferred;
    select.value = preferred;
  } else {
    flowYoYSite = options[0] || "US";
    select.value = flowYoYSite;
  }
}

function bindFlowYoYHandlers() {
  if (flowYoYHandlersBound) return;
  flowYoYHandlersBound = true;
  $("#flow-yoy-site-select")?.addEventListener("change", (e) => {
    flowYoYSite = e.target.value;
    renderFlowYoYTable();
  });
  $("#flow-yoy-table thead")?.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.sort;
    if (!key) return;
    if (flowYoYSort.key === key) flowYoYSort.asc = !flowYoYSort.asc;
    else flowYoYSort = { key, asc: key === "name" };
    renderFlowYoYTable();
  });
}

function renderFlowYoYTable() {
  bindFlowYoYHandlers();
  const section = $("#flow-yoy-section");
  const tbody = $("#flow-yoy-table tbody");
  const emptyEl = $("#flow-yoy-empty");
  const flowYoY = DATA.comparisons?.flowYoY;
  const sites = flowYoY?.sites || {};
  const hasAny = Object.keys(sites).length > 0;

  if (!section || !tbody) return;
  section.classList.toggle("hidden", !hasAny);
  if (!hasAny) {
    emptyEl?.classList.add("hidden");
    tbody.innerHTML = "";
    return;
  }

  setupFlowYoYSiteSelect();
  const rows = [...(sites[flowYoYSite] || [])];
  const { key, asc } = flowYoYSort;
  rows.sort((a, b) => {
    const av = flowYoYSortValue(a, key);
    const bv = flowYoYSortValue(b, key);
    if (typeof av === "string") return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    return asc ? av - bv : bv - av;
  });

  document.querySelectorAll("#flow-yoy-table th.sortable").forEach((th) => {
    th.classList.toggle("sorted-asc", th.dataset.sort === key && asc);
    th.classList.toggle("sorted-desc", th.dataset.sort === key && !asc);
  });

  if (!rows.length) {
    tbody.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    return;
  }
  emptyEl?.classList.add("hidden");

  tbody.innerHTML = rows
    .map((row) => {
      const cur = row.current || {};
      const yoy = row.yoy || {};
      const d = row.deltas || {};
      const rowCls = flowYoYRowClass(row);
      const nameCell = isWelcomeFlow(row.name)
        ? `<strong>${escapeHtml(row.name)}</strong> <span class="flow-yoy-tag">Welcome</span>`
        : escapeHtml(row.name);
      return `<tr class="${rowCls}">
        <td class="flow-yoy-name">${nameCell}</td>
        <td class="col-num">${(cur.delivered ?? 0).toLocaleString()}</td>
        <td class="col-num">${(yoy.delivered ?? 0).toLocaleString()}</td>
        <td class="col-num">${escapeHtml(signedPct(d.deliveredPct))}</td>
        <td class="col-num">${cur.convRate != null ? pct(cur.convRate, 2) : "—"}</td>
        <td class="col-num">${yoy.convRate != null ? pct(yoy.convRate, 2) : "—"}</td>
        <td class="col-num">${escapeHtml(signedRateDelta(d.convRateDelta))}</td>
        <td class="col-num">${escapeHtml(signedPct(d.gmvPct))}</td>
      </tr>`;
    })
    .join("");
}

function refreshOverview() {
  renderKpis();
  renderCharts();
  renderOverviewTable();
}

function showSection(name) {
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $("#metric-filter-wrap").classList.toggle("hidden", name !== "overview");
  if (name === "overview") refreshOverview();
  if (name === "comparison") renderComparison();
  if (name === "flow") renderFlow();
  if (name === "flow-insights") renderFlowInsights();
}

function refreshAllViews() {
  renderMeta();
  setupFlowInsightFilters();
  setupFlowAlertFilters();
  renderSites();
  renderFlow();
  renderFlowInsights();
  renderPlaybook();
  const section = $("#section-select").value;
  if (section === "overview") refreshOverview();
  if (section === "comparison") renderComparison();
}

async function applyPeriod(period, { silent = false, fallbackOnCustomMissing = false, replaceHistory = true } = {}) {
  if (period.preset === "custom" && period.start && period.end) {
    const norm = normalizeCustomPeriod(period.start, period.end);
    if (norm.clamped) {
      period = { ...period, start: norm.start, end: norm.end };
      if ($("#period-end")) $("#period-end").value = norm.end;
      if (!silent) showPeriodNotice(norm.message, false);
    }
  }
  currentPeriod = period;
  savePeriod(period);
  syncPeriodUi(period);
  syncUrlPeriod(period, { replace: replaceHistory });
  if (period.preset !== "custom") {
    stopCustomPolling();
  }

  let cachedCustom = null;
  if (period.preset === "custom" && period.start && period.end) {
    cachedCustom = await probeCustomData(period);
    if (cachedCustom) {
      DATA = cachedCustom;
      stopCustomPolling();
      $("#loading").classList.add("hidden");
      hideCustomEmpty();
      refreshAllViews();
      showSection($("#section-select").value);
      if (comparisonsMissingForPeriod(period, cachedCustom)) {
        showPeriodNotice(
          `自定义区间 ${period.start} ~ ${period.end} 已加载（缓存），同比/环比区块暂无完整数据。`,
          false
        );
        if (shouldTriggerCustomSync(period, cachedCustom)) {
          beginCustomAutoSync(period, { silent: true });
        }
      } else if (!dataIsFresh(cachedCustom)) {
        showPeriodNotice(
          `自定义区间 ${period.start} ~ ${period.end} 数据已超过 24 小时，正在后台刷新…`,
          false
        );
        beginCustomAutoSync(period, { silent: true, force: true });
      }
      return;
    }
  }

  if (!silent) {
    $("#loading").classList.remove("hidden");
    $("#error").classList.add("hidden");
    if (period.preset !== "custom" || !customPollTimer) {
      hideCustomEmpty();
    }
  }
  showPeriodNotice("");
  try {
    const { data } = await loadData(period);
    DATA = data;
    stopCustomPolling();
    $("#loading").classList.add("hidden");
    hideCustomEmpty();
    refreshAllViews();
    showSection($("#section-select").value);
    if (comparisonsMissingForPeriod(period, data)) {
      showPeriodNotice(
        `自定义区间 ${period.start} ~ ${period.end} 已加载，同比/环比区块暂无数据。`,
        false
      );
    }
  } catch (err) {
    $("#loading").classList.add("hidden");
    if (period.preset === "custom") {
      if (fallbackOnCustomMissing) {
        beginCustomAutoSync(period, { silent: true });
        try {
          const fallbackPeriod = { preset: "30d" };
          const { data } = await loadData(fallbackPeriod);
          DATA = data;
          currentPeriod = fallbackPeriod;
          syncPeriodUi(fallbackPeriod);
          syncUrlPeriod(fallbackPeriod, { replace: true });
          hideCustomEmpty();
          refreshAllViews();
          showSection($("#section-select").value);
        } catch (fallbackErr) {
          const el = $("#error");
          el.textContent = fallbackErr.message;
          el.classList.remove("hidden");
        }
      } else {
        showPeriodNotice(customMissingNotice(period), false);
        await beginCustomAutoSync(period);
      }
      return;
    }
    const el = $("#error");
    el.textContent = err.message;
    el.classList.remove("hidden");
  }
}


function bindPeriodControls() {
  document.querySelectorAll(".period-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyPeriod({ preset: btn.dataset.preset }, { replaceHistory: false });
    });
  });
  $("#period-apply")?.addEventListener("click", () => {
    const start = $("#period-start").value;
    const end = $("#period-end").value;
    const today = todayISO();
    if (!start || !end) {
      showPeriodNotice("请选择开始与结束日期", true);
      return;
    }
    if (start > end) {
      showPeriodNotice("开始日期不能晚于结束日期", true);
      return;
    }
    if (end > today) {
      showPeriodNotice(`结束日期不能晚于今天（${today}）`, true);
      $("#period-end").value = today;
      return;
    }
    if (start > today) {
      showPeriodNotice(`开始日期不能晚于今天（${today}）`, true);
      $("#period-start").value = today;
      return;
    }
    applyPeriod({ preset: "custom", start, end }, { replaceHistory: false });
  });
  $("#custom-fallback-30d")?.addEventListener("click", () => {
    applyPeriod({ preset: "30d" }, { replaceHistory: false });
  });
}

function bindHistoryNavigation() {
  window.addEventListener("popstate", () => {
    const urlPeriod = readUrlPeriod();
    const period = urlPeriod || { preset: "30d" };
    applyPeriod(period, { silent: true, replaceHistory: true });
  });
}

function showDomainHintIfNeeded() {
  const host = location.hostname;
  if (!host.endsWith(".github.io")) return;
  $("#domain-hint")?.classList.remove("hidden");
}

async function init() {
  try {
    showDomainHintIfNeeded();
    setupDatePickerLimits();
    bindPeriodControls();
    bindHistoryNavigation();
    bindFlowFilterHandlers();
    const urlPeriod = readUrlPeriod();
    const stored = urlPeriod || loadStoredPeriod();
    const fallbackCustom =
      !urlPeriod &&
      stored.preset === "custom" &&
      stored.start &&
      stored.end;
    await applyPeriod(stored, { silent: true, fallbackOnCustomMissing: fallbackCustom });
    metricView = $("#metric-view").value;

    $("#section-select").addEventListener("change", (e) => showSection(e.target.value));
    $("#metric-view").addEventListener("change", (e) => {
      metricView = e.target.value;
      refreshOverview();
    });
    $("#insight-drawer-close").addEventListener("click", closeInsightDrawer);
    $("#insight-backdrop").addEventListener("click", closeInsightDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeInsightDrawer();
    });
  } catch (err) {
    $("#loading").classList.add("hidden");
    const el = $("#error");
    el.textContent = err.message;
    el.classList.remove("hidden");
  }
}

document.addEventListener("DOMContentLoaded", init);
