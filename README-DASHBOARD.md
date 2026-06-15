# BLUETTI EDM Flow & Campaign Data

静态网页 + JSON 数据，覆盖 11 个 Klaviyo 站点：US、AU、CA、UK、FR、DE、IT、EU、ES、JP、CL。

**在线看板**：<https://bluetti-edm-databoard.netlify.app/>

分享或收藏时请带上统计周期参数，例如 `?period=30d` 或 `?start=2026-05-01&end=2026-05-31`。

备用 GitHub Pages（含个人账号前缀，不推荐对外分享）：<https://17793689850qjq-cyber.github.io/bluetti-edm-databoard/>

> **勿用**：`https://edm.bluetti.com/`（DNS 未配置）、`https://17793689850qjq-cyber.github.io/bluetti-edm-flow-campaign-data/`（404）、旧 Netlify 地址 `bluetti-edm-campaign.netlify.app`

若期望地址形如 `bluetti/bluetti-edm-databoard`（无个人 GitHub 用户名），请从下表三种方案中选一（**推荐方案 A**，语义最接近该写法）：

## 访问地址方案对比

| | **推荐方案 A** | **方案 B** | **方案 C** |
|---|----------------|------------|------------|
| **目标 URL** | `https://bluetti.github.io/bluetti-edm-databoard/` | `https://edm.bluetti.com/` | `https://bluetti.com/bluetti-edm-databoard/` |
| **是否含 github.io** | 是（组织名替代个人 ID） | **否** | **否** |
| **是否含 `/bluetti-edm-databoard/` 路径** | 是 | **否**（自定义域在根路径提供站点） | 是 |
| **谁来做** | GitHub 组织管理员 | 仓库维护者 + BLUETTI IT（DNS） | 公司 CDN / 反向代理团队 |
| **GitHub Pages 原生支持** | ✅ | ✅ | ❌（需代理把子路径转发到 Pages） |
| **难度** | 中（一次性迁仓） | 中（DNS + Pages 设置） | 高（基础设施） |

> **说明**：在个人账号下，仅重命名仓库只会改变 URL 路径，**不会**去掉 `17793689850qjq-cyber.github.io` 前缀。

## 架构

```
Klaviyo REST API  →  scripts/sync_dashboard.py  →  dashboard/data/dashboard-{7,30,60,90}d.json
                                                          ↓
                                              dashboard/index.html (GitHub Pages)
```

- **每日同步**：`.github/workflows/sync-dashboard.yml` 依次生成 7/30/60/90 天四套 JSON（`dashboard.json` 与 `dashboard-30d.json` 内容相同，默认 30 天）
- **页面部署**：`.github/workflows/deploy-pages.yml`（`dashboard/` 目录变更时自动发布）
- **页头区间选择**：预设切换加载对应 JSON；自定义范围需先通过 Actions 同步

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

**目标**：`https://bluetti.github.io/bluetti-edm-databoard/` — 最接近 `bluetti/bluetti-edm-databoard` 的合法写法；去掉个人账号名，仍保留 `github.io` 与仓库路径。

以下步骤需 **GitHub 组织 Owner** 在网页端完成（Agent / CI 无法代建组织或转移仓库）：

1. **创建组织**（若尚无）
   - 登录 GitHub → 右上角头像 → **Your organizations** → **New organization**
   - 选择 Free 计划，组织名填 `bluetti`（若已被占用，可用 `BLUETTI-Official` 等，但 URL 前缀会随之变化）
2. **转移仓库**
   - 打开 <https://github.com/17793689850qjq-cyber/bluetti-edm-databoard/settings>
   - 页面底部 **Danger Zone** → **Transfer ownership**
   - 目标组织选 `bluetti`，确认仓库名保持 `bluetti-edm-databoard`
3. **配置 GitHub Pages**
   - 迁仓后打开 `bluetti/bluetti-edm-databoard` → **Settings → Pages**
   - **Build and deployment** → Source 选 **GitHub Actions**（与现网一致）
   - 对 `main` 分支 push 一次或手动运行 **Deploy Dashboard to GitHub Pages**
4. **更新 Secrets**
   - 组织仓库 **Settings → Secrets and variables → Actions**
   - 将原个人仓库中的 `KLAVIYO_API_KEY_*` 等 Secret **逐一重新添加**（转移后 Secret 不会自动跟随）
5. **验收**
   - 访问 `https://bluetti.github.io/bluetti-edm-databoard/`
   - 确认 Actions 定时同步与 Pages 部署均成功

> 若希望地址为 `https://bluetti.github.io/`（无 `/bluetti-edm-databoard/`），需在组织下另建仓库 `bluetti.github.io`，将 `dashboard/` 内容作为站点根目录发布——与本仓库「项目站」模式不同，需单独规划。

## 方案 B：自定义子域 `edm.bluetti.com`

**目标**：`https://edm.bluetti.com/` — 完全无 `github.io`、无 `/bluetti-edm-databoard/` 路径；对外分享最简洁。

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

> DNS 未生效前，`https://17793689850qjq-cyber.github.io/bluetti-edm-databoard/` 仍可正常访问。

## 方案 C：`bluetti.com/bluetti-edm-databoard/`（子路径）

**目标**：`https://bluetti.com/bluetti-edm-databoard/` — GitHub Pages **不支持**在自定义域上挂载子路径；必须由公司 **CDN / 反向代理** 将 `/bluetti-edm-databoard/` 转发到 GitHub Pages 实际地址（个人账号或组织账号下的项目站 URL）。

典型做法（由基础设施团队配置，非本仓库代码范围）：

1. 源站指向 `https://bluetti.github.io/bluetti-edm-databoard/`（方案 A 完成后）或当前 `https://17793689850qjq-cyber.github.io/bluetti-edm-databoard/`
2. 在 `bluetti.com` 上配置路径规则：`/bluetti-edm-databoard/*` → 反向代理到上述 GitHub Pages URL
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

- 统计周期：页头可选近 7/30/60/90 天或自定义（需预同步 JSON）
- 转化 Metric：Placed Order
- GMV：各站本位币，汇总按固定汇率折算 CNY
- Campaign：已发送邮件
- Flow：Live / Draft，周期内有发送量

## 看板视图

1. **全球总览** — KPI、GMV 饼图/柱状图、各站对比表
2. **分站诊断** — 按站点折叠，Campaign / Flow 最佳与待优化（含 Subject 解读）
3. **Flow 待关注** — Draft、Sunset 等待处理项
4. **Playbook** — 成功/失败模式清单

## 自定义区间限制（静态站点）

GitHub Pages 无法按需调用 Klaviyo API。自定义日期需先在 Actions 或本地运行 `sync_dashboard.py --start … --end …` 生成对应 JSON 后，看板才能加载该区间数据。
