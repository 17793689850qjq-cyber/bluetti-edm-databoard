const DEFAULT_OWNER = "17793689850qjq-cyber";
const DEFAULT_REPO = "bluetti-edm-dashboard";
const WORKFLOW_FILE = "sync-dashboard.yml";
const DEFAULT_REF = "main";

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function parseDates(event) {
  const q = event.queryStringParameters || {};
  const start = q.start || q.start_date;
  const end = q.end || q.end_date;
  if (start && end) return { start, end };

  if (event.body) {
    try {
      const body = JSON.parse(event.body);
      if (body.start && body.end) return { start: body.start, end: body.end };
    } catch (_) {
      /* ignore */
    }
  }
  return { start: null, end: null };
}

function isValidDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function customDataPath(start, end) {
  return `/data/dashboard-custom-${start}_${end}.json`;
}

function hasComparisonData(data) {
  const metrics = data?.comparisons?.global?.totals?.metrics;
  return Array.isArray(metrics) && metrics.length > 0;
}

async function probeCustomDashboard(host, start, end) {
  const proto = host?.includes("localhost") ? "http" : "https";
  const base = host ? `${proto}://${host}` : "";
  const url = `${base}${customDataPath(start, end)}`;
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) return { exists: false, complete: false, data: null };
    const data = await res.json();
    return { exists: true, complete: hasComparisonData(data), data };
  } catch (_) {
    return { exists: false, complete: false, data: null };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed", triggered: false });
  }

  const { start, end } = parseDates(event);
  if (!isValidDate(start) || !isValidDate(end)) {
    return json(400, {
      error: "需要 start 与 end 参数，格式 YYYY-MM-DD",
      triggered: false,
    });
  }
  if (start > end) {
    return json(400, { error: "开始日期不能晚于结束日期", triggered: false });
  }

  const host = event.headers?.host || event.headers?.["x-forwarded-host"];
  const probe = await probeCustomDashboard(host, start, end);
  if (probe.complete) {
    return json(200, {
      triggered: false,
      alreadyExists: true,
      complete: true,
      start,
      end,
      message: "该日期范围数据已在站点上，无需触发同步。",
    });
  }
  if (probe.exists) {
    return json(200, {
      triggered: false,
      alreadyExists: true,
      complete: false,
      start,
      end,
      message: "数据文件已存在但缺少同比/环比，请等待 GitHub Actions 同步或联系管理员更新。",
    });
  }

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    return json(503, {
      code: "pat_missing",
      error: "后台同步尚未配置（一次性设置）",
      setup:
        "在 Netlify 站点 bluetti-edm-dashboard → Site configuration → Environment variables 添加 GITHUB_PAT：GitHub Classic PAT，勾选 repo + workflow。设置后重新选择日期即可自动同步。",
      triggered: false,
      needsSync: true,
    });
  }

  const owner = process.env.GITHUB_REPO_OWNER || DEFAULT_OWNER;
  const repo = process.env.GITHUB_REPO_NAME || DEFAULT_REPO;
  const ref = process.env.GITHUB_REF || DEFAULT_REF;
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "bluetti-edm-dashboard-trigger-sync",
    },
    body: JSON.stringify({
      ref,
      inputs: { start_date: start, end_date: end },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return json(res.status, {
      error: `GitHub workflow_dispatch 失败 (${res.status})`,
      detail: detail.slice(0, 500),
      triggered: false,
    });
  }

  return json(200, { triggered: true, start, end, ref });
};
