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
const CUSTOM_POLL_MAX_MS = 600000;

let customPollTimer = null;
let customPollStartedAt = 0;
let customPollPeriod = null;

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

function savePeriod(period) {
  localStorage.setItem(PERIOD_STORAGE_KEY, JSON.stringify(period));
}

function readUrlPeriod() {
  const params = new URLSearchParams(window.location.search);
  const start = params.get("start");
  const end = params.get("end");
  if (start && end) return { preset: "custom", start, end };
  const preset = params.get("period");
  if (preset && PRESET_DAYS[preset]) return { preset };
  return null;
}

function openWorkflowDispatch(start, end) {
  window.open(workflowDispatchUrl(start, end), "_blank", "noopener,noreferrer");
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

function updateCustomPollStatus(period, elapsedMs) {
  const el = $("#custom-poll-status");
  if (!el) return;
  const mins = Math.floor(elapsedMs / 60000);
  const secs = Math.floor((elapsedMs % 60000) / 1000);
  const remainingMin = Math.max(0, Math.ceil((CUSTOM_POLL_MAX_MS - elapsedMs) / 60000));
  el.textContent = `同步进行中 · ${period.start} ~ ${period.end} · 已等待 ${mins}:${String(secs).padStart(2, "0")} · 约 ${remainingMin} 分钟后超时`;
  el.classList.remove("hidden");
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

function startCustomSyncPolling(period) {
  stopCustomPolling();
  customPollPeriod = { ...period };
  customPollStartedAt = Date.now();
  showCustomEmpty(period, { polling: true });

  const tick = async () => {
    const elapsed = Date.now() - customPollStartedAt;
    updateCustomPollStatus(period, elapsed);
    if (elapsed > CUSTOM_POLL_MAX_MS) {
      stopCustomPolling();
      const el = $("#custom-poll-status");
      if (el) {
        el.textContent = "等待超时。可再次点击「自动同步」，或在 GitHub Actions 查看运行状态。";
      }
      return;
    }
    const data = await probeCustomData(period);
    if (data) {
      stopCustomPolling();
      DATA = data;
      hideCustomEmpty();
      $("#loading").classList.add("hidden");
      refreshAllViews();
      showSection($("#section-select").value);
      showPeriodNotice(`自定义范围 ${period.start} ~ ${period.end} 已同步并自动加载。`, false);
    }
  };

  tick();
  customPollTimer = setInterval(tick, CUSTOM_POLL_INTERVAL_MS);
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

function showCustomEmpty(period, { polling = false } = {}) {
  hideAllViews();
  $("#error")?.classList.add("hidden");
  const el = $("#custom-empty");
  if (!el) return;
  $("#custom-empty-range").textContent = `${period.start} ~ ${period.end}`;
  const link = $("#custom-sync-link");
  if (link) link.href = workflowDispatchUrl(period.start, period.end);
  const autoBtn = $("#custom-auto-sync");
  if (autoBtn) {
    autoBtn.disabled = polling;
    autoBtn.textContent = polling ? "同步中…" : "自动同步";
    if (!autoBtn.dataset.bound) {
      autoBtn.dataset.bound = "1";
      autoBtn.addEventListener("click", () => {
        if (currentPeriod.preset !== "custom" || !currentPeriod.start || !currentPeriod.end) return;
        openWorkflowDispatch(currentPeriod.start, currentPeriod.end);
        startCustomSyncPolling(currentPeriod);
      });
    }
  }
  el.classList.toggle("syncing", polling);
  if (!polling) {
    $("#custom-poll-status")?.classList.add("hidden");
  }
  el.classList.remove("hidden");
}

function customMissingNotice(period) {
  const wf = workflowDispatchUrl(period.start, period.end);
  return `自定义范围 <strong>${period.start} ~ ${period.end}</strong> 尚未同步。<button type="button" class="link-btn" id="notice-auto-sync">一键自动同步</button> 或 <a href="${wf}" target="_blank" rel="noopener">在 GitHub Actions 手动运行</a>。`;
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
}

async function applyPeriod(period, { silent = false, fallbackOnCustomMissing = false, replaceHistory = true } = {}) {
  currentPeriod = period;
  savePeriod(period);
  syncPeriodUi(period);
  syncUrlPeriod(period, { replace: replaceHistory });
  if (period.preset !== "custom") {
    stopCustomPolling();
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
  } catch (err) {
    $("#loading").classList.add("hidden");
    if (period.preset === "custom") {
      showCustomEmpty(period);
      showPeriodNotice(customMissingNotice(period), true);
      if (fallbackOnCustomMissing) {
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
          showPeriodNotice(
            `已加载近 30 天数据。${customMissingNotice(period)}`,
            true
          );
        } catch (fallbackErr) {
          const el = $("#error");
          el.textContent = fallbackErr.message;
          el.classList.remove("hidden");
        }
      }
      return;
    }
    const el = $("#error");
    el.textContent = err.message;
    el.classList.remove("hidden");
  }
}

function bindNoticeAutoSync() {
  $("#period-notice")?.addEventListener("click", (e) => {
    if (e.target.id !== "notice-auto-sync") return;
    if (currentPeriod.preset !== "custom" || !currentPeriod.start || !currentPeriod.end) return;
    openWorkflowDispatch(currentPeriod.start, currentPeriod.end);
    startCustomSyncPolling(currentPeriod);
  });
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
    if (!start || !end) {
      showPeriodNotice("请选择开始与结束日期", true);
      return;
    }
    if (start > end) {
      showPeriodNotice("开始日期不能晚于结束日期", true);
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
    bindPeriodControls();
    bindNoticeAutoSync();
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
