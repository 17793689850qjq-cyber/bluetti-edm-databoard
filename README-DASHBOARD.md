# BLUETTI EDM Flow & Campaign Data

静态网页 + JSON 数据，覆盖 11 个 Klaviyo 站点：US、AU、CA、UK、FR、DE、IT、EU、ES、JP、CL。

**在线看板**：<https://bluetti-edm-dashboard.netlify.app/>

分享或收藏时请带上统计周期参数，例如 `?period=30d` 或 `?start=2026-05-01&end=2026-05-31`。

备用 GitHub Pages（含个人账号前缀，不推荐对外分享）：<https://17793689850qjq-cyber.github.io/bluetti-edm-dashboard/>

> **勿用**：`https://edm.bluetti.com/`（DNS 未配置）、`https://17793689850qjq-cyber.github.io/bluetti-edm-flow-campaign-data/`（404）、旧 Netlify 地址 `bluetti-edm-campaign.netlify.app`

若期望地址形如 `bluetti/bluetti-edm-dashboard`（无个人 GitHub 用户名），请从下表三种方案中选一（**推荐方案 A**，语义最接近该写法）：

## 访问地址方案对比

| | **推荐方案 A** | **方案 B** | **方案 C** |
|---|----------------|------------|------------|
| **目标 URL** | `https://bluetti.github.io/bluetti-edm-dashboard/` | `https://edm.bluetti.com/` | `https://bluetti.com/bluetti-edm-dashboard/` |
| **是否含 github.io** | 是（组织名替代个人 ID） | **否** | **否** |
| **是否含 `/bluetti-edm-dashboard/` 路径** | 是 | **否**（自定义域在根路径提供站点） | 是 |
| **谁来做** | GitHub 组织管理员 | 仓库维护者 + BLUETTI IT（DNS） | 公司 CDN / 反向代理团队 |
| **GitHub Pages 原生支持** | ✅ | ✅ | ❌（需代理把子路径转发到 Pages） |
| **难度** | 中（一次性迁仓） | 中（DNS + Pages 设置） | 高（基础设施） |

> **说明**：在个人账号下，仅重命名仓库只会改变 URL 路径，**不会**去掉 `17793689850qjq-cyber.github.io` 前缀。

## 架构

```
Klaviyo REST API  →  scripts/sync_dashboard.py  →  dashboard/data/dashboard-{7,30,60,90}d.json
                                                          ↓
                                              Netlify CDN（bluetti-edm-dashboard.netlify.app）
```

- **每日同步**：`.github/workflows/sync-dashboard.yml` 依次生成 7/30/60/90 天四套 JSON、上月、本月至今、**当年每个自然月（YTD）**
- **页面部署（Netlify，推荐）**：`.github/workflows/deploy-netlify.yml` 或 `deploy-netlify.ps1`
- **页头区间选择**：预设（7/30/60/90 天）及自定义；**缓存命中即时加载（<1 秒）**，未缓存才触发后台同步

## 性能与瓶颈（为何自定义日期首次要等 5–10 分钟）

### 单次自定义区间 API 调用量（11 站）

`sync_dashboard.py` 对每个自定义区间（含 MoM/YoY）大致调用：

| 阶段 | 每站 | ×11 站 | 说明 |
|------|------|--------|------|
| 本期主数据 | campaign + flow | **22** | 含站点诊断、Playbook |
| 环比 MoM | campaign + flow | **22** | 仅汇总指标 |
| 同比 YoY | campaign + flow | **22** | 仅汇总指标 |
| Flow 逐条同比 flowYoY | flow × 2（本期+去年） | **22** | 最慢，可用 `--skip-flow-yoy` 跳过 |
| **合计（报告 API）** | | **≈88 POST** | 另加 entity-cache GET（campaign 名称/subject，数十～上百次） |

### 其他延迟来源

| 环节 | 典型耗时 | 说明 |
|------|----------|------|
| 顺序/限流 sleep | ~1–2 分钟 | 每站 `API_THROTTLE_SEC=0.5`（可用环境变量调整） |
| Klaviyo 响应 | 3–6 分钟 | 报告 API 单次 1–5 秒；**3 站并行** + **429 自动重试** |
| GitHub Actions 排队 + 运行 | 1–3 分钟 | `workflow_dispatch` 触发 |
| git push + Netlify 部署 | 1–3 分钟 | 数据 commit 后触发 build hook |

**用户感知的「首次自定义」总等待 ≈ 同步 5–8 分钟 + 部署 2–4 分钟。**

### 已实现的加速策略

1. **预同步（每日 06:00 UTC）**：7/30/60/90 天、上月、本月至今、**2026 年各自然月（1 月～当前月）** → 选整月 = **CDN 即时加载**
2. **缓存命中**：JSON 已在 Netlify 时，`app.js` 先 probe 再展示，**不显示 loading spinner**
3. **24 小时新鲜度**：同一区间 24h 内不重复触发 `workflow_dispatch`
4. **`--skip-flow-yoy`**：每日批量预同步跳过 Flow 逐条同比（节省 ~2 分钟）；**自定义 `workflow_dispatch` 默认也跳过**（先出主表 + MoM/YoY 汇总）；需要 Flow 同比/对比时在 Actions 勾选 `include_flow_yoy=true`
5. **3 站并行 + 更短 throttle**：较原先纯顺序约快 40–50%
6. **24h 内不重复触发**：`trigger-sync` 与前端均探测已有新鲜 JSON，命中则跳过 `workflow_dispatch`

### 「即时自定义」路线图

| 方案 | 状态 | 说明 |
|------|------|------|
| **A. 月度预同步（当前 MVP）** | ✅ 已上线 | 选 2026 任一整月 → 即时；非整月仍触发同步 |
| B. 90 天日粒度 JSON + 浏览器聚合 | 待评估 | Klaviyo 日粒度报告体积大；需验证 API 是否支持 |
| C. Netlify Function 直连 Klaviyo | 备选 | 跳过 GitHub Actions 排队，但仍需 5+ 分钟拉数 |


## Netlify 自动部署（GitHub Actions）

在仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 值 |
|--------|-----|
| `NETLIFY_AUTH_TOKEN` | [Netlify User settings → Applications → Personal access tokens](https://app.netlify.com/user/applications#personal-access-tokens) 新建 token（Full access 或至少 Deploy） |
| `NETLIFY_SITE_ID` | `f64cc0c9-dcf5-4028-a1d8-fdc1de1d61d2`（站点 `bluetti-edm-dashboard`） |

在 Netlify 站点 **Site configuration → Environment variables** 添加（用于自定义日期自动同步）：

| 变量 | 值 |
|------|-----|
| `GITHUB_PAT` | GitHub Personal Access Token（Classic），勾选 `repo` + `workflow`，用于调用 `workflow_dispatch` 触发 `sync-dashboard.yml` |
| `GITHUB_REPO_OWNER` | 可选，默认 `17793689850qjq-cyber` |
| `GITHUB_REPO_NAME` | 可选，默认 `bluetti-edm-databoard` |
| `NETLIFY_BUILD_HOOK` | 可选，同步完成后触发 Netlify 部署；未设置时 fallback 为 `deploy-netlify.yml` workflow_dispatch |

## 一次性配置自定义日期自动同步

看板选择自定义日期时，Netlify Function `trigger-sync` 会用 `GITHUB_PAT` 调用 GitHub `workflow_dispatch` 拉取 Klaviyo 数据。当前站点 **尚未配置** `GITHUB_PAT`（测试 `trigger-sync?start=2026-04-01&end=2026-04-30` 返回 `503 pat_missing`）。

按以下 **3 步** 完成（约 5 分钟，只需做一次）：

### 第 1 步：创建 GitHub Classic PAT

1. 打开 <https://github.com/settings/tokens> → **Generate new token (classic)**
2. Note 填 `bluetti-edm-dashboard-sync`，Expiration 建议 90 天或 No expiration
3. 勾选 **`repo`**（整组）和 **`workflow`**
4. 生成后 **立即复制** token（`ghp_...`），关闭页面后无法再查看

> `gh auth login` 的 OAuth token **不能** 用于 `workflow_dispatch`，必须用 Classic PAT。

### 第 2 步：写入 Netlify 环境变量

任选一种方式：

**网页**：<https://app.netlify.com/projects/bluetti-edm-dashboard/configuration/env#content> → Add variable → Key=`GITHUB_PAT`，Value=上一步 token，Scopes 选 **Production**（建议同时勾选 Deploy previews / Branch deploys）。

**CLI**（需已 `netlify login`）：

```powershell
netlify env:set GITHUB_PAT "ghp_你的token" --context production
```

### 第 3 步：验收

```powershell
# 应返回 HTTP 200，JSON 含 "triggered": true
curl "https://bluetti-edm-dashboard.netlify.app/.netlify/functions/trigger-sync?start=2026-04-01&end=2026-04-30"
```

或在看板页头选择 2026-04-01 ~ 2026-04-30 点击「应用」，应出现「正在后台同步…」而非 PAT 配置提示。

---

**可选：加速同步后的 Netlify 部署**

在仓库 <https://github.com/17793689850qjq-cyber/bluetti-edm-databoard/settings/secrets/actions> 添加 Secret：

| Secret | 值 |
|--------|-----|
| `NETLIFY_BUILD_HOOK` | Netlify 站点 **Site configuration → Build hooks** 新建 hook（branch: `main`）得到的 URL，形如 `https://api.netlify.com/build_hooks/...` |

未设置时，同步 workflow 会自动 fallback 触发 `deploy-netlify.yml`（需 `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` 已配置）。

本地一键部署（需先 `netlify login` 或设置 `NETLIFY_AUTH_TOKEN`）：

```powershell
.\deploy-netlify.ps1
```

## 本地预览（无需 API Key）

```bash
cd scripts
python build_seed_dashboard.py --all-presets

cd ../dashboard
python -m http.server 8080
# 打开 http://localhost:8080
```

## 配置 GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 添加各站 Private API Key：

| Secret 名称 | 站点 |
|-------------|------|
| `KLAVIYO_API_KEY_US` | 美国 |
| `KLAVIYO_API_KEY_AU` | 澳大利亚 |
| `KLAVIYO_API_KEY_CA` | 加拿大 |
| `KLAVIYO_API_KEY_UK` | 英国 |
| `KLAVIYO_API_KEY_FR` | 法国 |
| `KLAVIYO_API_KEY_DE` | 德国 |
| `KLAVIYO_API_KEY_IT` | 意大利 |
| `KLAVIYO_API_KEY_EU` | 泛欧账号 |
| `KLAVIYO_API_KEY_ES` | 西班牙 |
| `KLAVIYO_API_KEY_JP` | 日本 |
| `KLAVIYO_API_KEY_CL` | 智利 |

API Key 需具备 **Reporting** 读取权限。未配置的站点会在同步时跳过，并在 JSON 的 `meta.errors` 中记录。

## 启用 GitHub Pages

1. 仓库 **Settings → Pages**
2. **Build and deployment** → Source 选 **GitHub Actions**
3. 首次 push `dashboard/` 后，`Deploy Dashboard to GitHub Pages` workflow 会自动运行

## 推荐方案 A：迁到 GitHub 组织 `bluetti`

**目标**：`https://bluetti.github.io/bluetti-edm-dashboard/` — 最接近 `bluetti/bluetti-edm-dashboard` 的合法写法；去掉个人账号名，仍保留 `github.io` 与仓库路径。

以下步骤需 **GitHub 组织 Owner** 在网页端完成（Agent / CI 无法代建组织或转移仓库）：

1. **创建组织**（若尚无）
   - 登录 GitHub → 右上角头像 → **Your organizations** → **New organization**
   - 选择 Free 计划，组织名填 `bluetti`（若已被占用，可用 `BLUETTI-Official` 等，但 URL 前缀会随之变化）
2. **转移仓库**
   - 打开 <https://github.com/17793689850qjq-cyber/bluetti-edm-dashboard/settings>
   - 页面底部 **Danger Zone** → **Transfer ownership**
   - 目标组织选 `bluetti`，确认仓库名保持 `bluetti-edm-dashboard`
3. **配置 GitHub Pages**
   - 迁仓后打开 `bluetti/bluetti-edm-dashboard` → **Settings → Pages**
   - **Build and deployment** → Source 选 **GitHub Actions**（与现网一致）
   - 对 `main` 分支 push 一次或手动运行 **Deploy Dashboard to GitHub Pages**
4. **更新 Secrets**
   - 组织仓库 **Settings → Secrets and variables → Actions**
   - 将原个人仓库中的 `KLAVIYO_API_KEY_*` 等 Secret **逐一重新添加**（转移后 Secret 不会自动跟随）
5. **验收**
   - 访问 `https://bluetti.github.io/bluetti-edm-dashboard/`
   - 确认 Actions 定时同步与 Pages 部署均成功

> 若希望地址为 `https://bluetti.github.io/`（无 `/bluetti-edm-dashboard/`），需在组织下另建仓库 `bluetti.github.io`，将 `dashboard/` 内容作为站点根目录发布——与本仓库「项目站」模式不同，需单独规划。

## 方案 B：自定义子域 `edm.bluetti.com`

**目标**：`https://edm.bluetti.com/` — 完全无 `github.io`、无 `/bluetti-edm-dashboard/` 路径；对外分享最简洁。

**在 DNS 生效之前，仓库内不要提交 `dashboard/CNAME` 文件**（未验证的自定义域可能导致 Pages 异常）。待 IT 完成 DNS 后再按下列步骤启用。

### 仓库维护者

1. 与 IT 确认最终子域（如 `edm.bluetti.com`）
2. **先**由 IT 添加 DNS CNAME（见下表），**再**新建 `dashboard/CNAME`（内容仅一行域名，与 Pages 设置一致）并 push 到 `main`
3. 仓库 **Settings → Pages** → **Custom domain** 填入同一域名 → **Save**
4. DNS 检查通过后勾选 **Enforce HTTPS**

### BLUETTI IT（DNS）

在 `bluetti.com` DNS 控制台添加 CNAME：

| 类型 | 主机记录 | 记录值（当前个人账号） | 记录值（若已执行方案 A） |
|------|----------|------------------------|--------------------------|
| CNAME | `edm` | `17793689850qjq-cyber.github.io` | `bluetti.github.io` |

其他可选子域：`klaviyo.bluetti.com`、`data.bluetti.com`、`edm-data.bluetti.com`（需同步改 CNAME 与 Pages 设置）。

> DNS 未生效前，`https://17793689850qjq-cyber.github.io/bluetti-edm-dashboard/` 仍可正常访问。

## 方案 C：`bluetti.com/bluetti-edm-dashboard/`（子路径）

**目标**：`https://bluetti.com/bluetti-edm-dashboard/` — GitHub Pages **不支持**在自定义域上挂载子路径；必须由公司 **CDN / 反向代理** 将 `/bluetti-edm-dashboard/` 转发到 GitHub Pages 实际地址（个人账号或组织账号下的项目站 URL）。

典型做法（由基础设施团队配置，非本仓库代码范围）：

1. 源站指向 `https://bluetti.github.io/bluetti-edm-dashboard/`（方案 A 完成后）或当前 `https://17793689850qjq-cyber.github.io/bluetti-edm-dashboard/`
2. 在 `bluetti.com` 上配置路径规则：`/bluetti-edm-dashboard/*` → 反向代理到上述 GitHub Pages URL
3. 注意静态资源与 `base` 路径：若代理未剥离路径前缀，可能需要额外调整前端资源路径（优先推荐方案 A 或 B 以避免此问题）

## 自定义域名子域备选（方案 B）

`dashboard/CNAME` 与 Pages **Custom domain** 必须完全一致。推荐子域：

| 子域 | 说明 |
|------|------|
| `edm.bluetti.com` | 简短易记（推荐） |
| `edm-data.bluetti.com` | 与仓库名一致 |
| `klaviyo.bluetti.com` | 强调数据来源 |

选定后，在 DNS 就绪时创建 `dashboard/CNAME`（仅含所选域名一行），勿提前提交。

## 手动同步

Actions 页选择 **Sync Klaviyo Dashboard** → **Run workflow**：

- 默认：同步 7/30/60/90 天四套数据
- 可选 `days`：仅同步单个预设
- 可选 `start_date` + `end_date`：自定义区间，输出 `dashboard-custom-YYYY-MM-DD_YYYY-MM-DD.json`

本地：

```bash
cd scripts
python sync_dashboard.py --days 30
python sync_dashboard.py --start 2025-05-01 --end 2025-05-31
```

## 数据口径

- 统计周期：页头可选近 7/30/60/90 天或自定义（自定义首次选择自动后台同步）
- 转化 Metric：Placed Order
- GMV：各站本位币，汇总按固定汇率折算 CNY
- Campaign：已发送邮件
- Flow：Live / Draft，周期内有发送量

## 看板视图

1. **全球总览** — KPI、GMV 饼图/柱状图、各站对比表
2. **分站诊断** — 按站点折叠，Campaign / Flow 最佳与待优化（含 Subject 解读）
3. **Flow 待关注** — Draft、Sunset 等待处理项
4. **Playbook** — 成功/失败模式清单

## 自定义区间（自动同步）

预设区间（7 / 30 / 60 / 90 天）、**上一个自然月**、**本月至今**、**当年各自然月（YTD）** 由 GitHub Actions 每日 06:00 UTC 自动同步。

选择页头自定义日期并点击「应用」时：

1. 看板先尝试加载 `dashboard-custom-YYYY-MM-DD_YYYY-MM-DD.json`（**命中则 <1 秒展示，无 spinner**）
2. 若不存在且数据超过 24 小时未更新，Netlify Function `trigger-sync` 调用 GitHub `workflow_dispatch`
3. 页面显示「预计还需约 6 分钟」，每 15 秒轮询，就绪后自动展示
4. 自定义默认同步跳过 Flow 逐条同比（主表 + 汇总同比环比仍有）；Flow 明细页可能为空，可在 Actions 勾选全量补拉

**2026 年 6 月整月**：`?start=2026-06-01&end=2026-06-30` 或页头选择 6/1–6/30，数据文件 `dashboard-custom-2026-06-01_2026-06-30.json` 已预同步。

若自动触发失败，可点击「重试同步」；「GitHub 排查」仅供管理员查看 Actions 运行状态。

本地手动同步（可选）：

```powershell
# 从 MCP 配置注入 API Key 后同步指定区间
$mcp = Get-Content "$env:USERPROFILE\.cursor\mcp.json" | ConvertFrom-Json
$env:KLAVIYO_API_KEY_US = $mcp.mcpServers.'klaviyo US'.env.PRIVATE_API_KEY
# … 其他站点同理 …
cd scripts
python sync_dashboard.py --start 2026-06-01 --end 2026-06-30
```
