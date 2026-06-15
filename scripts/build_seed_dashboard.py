#!/usr/bin/env python3
"""Build dashboard/data/dashboard.json from snapshot (no API keys required)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from klaviyo_config import FAILURE_PLAYBOOK, SITE_ORDER, SUCCESS_PLAYBOOK, TIMEFRAME
from ranking import build_flow_insights

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dashboard" / "data" / "dashboard.json"
SEED_WHY = Path(__file__).resolve().parent / "seed_site_why.json"

ROWS = [
    {"region": "US", "currency": "USD", "campaign": {"deliveryRate": 0.9981, "openRate": 0.476, "clickRate": 0.0129, "convRate": 0.000283, "gmv": 487639.52, "conversions": 444, "delivered": 1570693}, "flow": {"deliveryRate": 0.968, "openRate": 0.372, "clickRate": 0.039, "convRate": 0.00601, "gmv": 451316.84, "conversions": 372, "delivered": 61929}, "campaignGmvCny": 3354960, "flowGmvCny": 3105060, "totalGmvCny": 6460020},
    {"region": "AU", "currency": "AUD", "campaign": {"deliveryRate": 0.9987, "openRate": 0.562, "clickRate": 0.0369, "convRate": 0.00163, "gmv": 591494.91, "conversions": 386, "delivered": 236410}, "flow": {"deliveryRate": 0.988, "openRate": 0.447, "clickRate": 0.0762, "convRate": 0.0163, "gmv": 440826.51, "conversions": 288, "delivered": 17621}, "campaignGmvCny": 2892410, "flowGmvCny": 2155642, "totalGmvCny": 5048052},
    {"region": "CA", "currency": "CAD", "campaign": {"deliveryRate": 0.9989, "openRate": 0.494, "clickRate": 0.0203, "convRate": 0.0006, "gmv": 248958.42, "conversions": 219, "delivered": 364870}, "flow": {"deliveryRate": 0.9927, "openRate": 0.599, "clickRate": 0.1026, "convRate": 0.0168, "gmv": 296946.16, "conversions": 244, "delivered": 14560}, "campaignGmvCny": 1252261, "flowGmvCny": 1493639, "totalGmvCny": 2745900},
    {"region": "UK", "currency": "GBP", "campaign": {"deliveryRate": 0.9941, "openRate": 0.351, "clickRate": 0.0149, "convRate": 0.000346, "gmv": 83122.62, "conversions": 118, "delivered": 341464}, "flow": {"deliveryRate": 0.9902, "openRate": 0.365, "clickRate": 0.0647, "convRate": 0.0112, "gmv": 109522, "conversions": 149, "delivered": 13360}, "campaignGmvCny": 773872, "flowGmvCny": 1019650, "totalGmvCny": 1793521},
    {"region": "FR", "currency": "EUR", "campaign": {"deliveryRate": 0.9954, "openRate": 0.289, "clickRate": 0.0161, "convRate": 0.000512, "gmv": 74549, "conversions": 105, "delivered": 205271}, "flow": {"deliveryRate": 0.9948, "openRate": 0.467, "clickRate": 0.0886, "convRate": 0.015, "gmv": 109154.55, "conversions": 120, "delivered": 8015}, "campaignGmvCny": 605338, "flowGmvCny": 886335, "totalGmvCny": 1491673},
    {"region": "DE", "currency": "EUR", "campaign": {"deliveryRate": 0.9982, "openRate": 0.384, "clickRate": 0.0318, "convRate": 0.00103, "gmv": 79100.44, "conversions": 178, "delivered": 173484}, "flow": {"deliveryRate": 0.9714, "openRate": 0.502, "clickRate": 0.0923, "convRate": 0.0112, "gmv": 59409.04, "conversions": 88, "delivered": 7851}, "campaignGmvCny": 642296, "flowGmvCny": 482401, "totalGmvCny": 1124697},
    {"region": "IT", "currency": "EUR", "campaign": {"deliveryRate": 0.9984, "openRate": 0.309, "clickRate": 0.0154, "convRate": 0.000348, "gmv": 60075.76, "conversions": 60, "delivered": 172548}, "flow": {"deliveryRate": 0.9899, "openRate": 0.466, "clickRate": 0.095, "convRate": 0.0146, "gmv": 86809.01, "conversions": 104, "delivered": 7134}, "campaignGmvCny": 487815, "flowGmvCny": 704889, "totalGmvCny": 1192704},
    {"region": "EU", "currency": "EUR", "campaign": {"deliveryRate": 0.9983, "openRate": 0.318, "clickRate": 0.0177, "convRate": 0.000215, "gmv": 48103.58, "conversions": 68, "delivered": 316069}, "flow": {"deliveryRate": 0.9908, "openRate": 0.339, "clickRate": 0.0572, "convRate": 0.00718, "gmv": 100161.16, "conversions": 113, "delivered": 15747}, "campaignGmvCny": 390601, "flowGmvCny": 813309, "totalGmvCny": 1203910},
    {"region": "ES", "currency": "EUR", "campaign": {"deliveryRate": 0.998, "openRate": 0.316, "clickRate": 0.0179, "convRate": 0.000285, "gmv": 34461.27, "conversions": 38, "delivered": 133479}, "flow": {"deliveryRate": 0.9895, "openRate": 0.427, "clickRate": 0.076, "convRate": 0.00868, "gmv": 49622.33, "conversions": 64, "delivered": 7377}, "campaignGmvCny": 279826, "flowGmvCny": 402933, "totalGmvCny": 682759},
    {"region": "JP", "currency": "JPY", "campaign": {"deliveryRate": 0.9971, "openRate": 0.4, "clickRate": 0.0154, "convRate": 0.000539, "gmv": 7647712, "conversions": 158, "delivered": 293242}, "flow": {"deliveryRate": 0.994, "openRate": 0.206, "clickRate": 0.0645, "convRate": 0.0125, "gmv": 2501067, "conversions": 35, "delivered": 2804}, "campaignGmvCny": 336499, "flowGmvCny": 110047, "totalGmvCny": 446546},
    {"region": "CL", "currency": "CLP", "campaign": {"deliveryRate": 0.9959, "openRate": 0.278, "clickRate": 0.0206, "convRate": 0.000745, "gmv": 18453723, "conversions": 23, "delivered": 30890}, "flow": {"deliveryRate": 0.9902, "openRate": 0.508, "clickRate": 0.0841, "convRate": 0.0176, "gmv": 18529020, "conversions": 23, "delivered": 1308}, "campaignGmvCny": 145784, "flowGmvCny": 146379, "totalGmvCny": 292164},
]

FLOW_ALERTS = [
    {"priority": "P0", "region": "US", "flow": "Welcome flow · Email 1", "category": "Welcome", "issue": "首封打开 28%，低于同序列后续邮件（38%）", "action": "A/B 首封 Subject 或调整发送顺序"},
    {"priority": "P1", "region": "IT", "flow": "Avviso spedizione Elite 30 V2", "category": "Draft", "issue": "Draft 状态仍有发送", "action": "确认 Live / 合并 / 下线"},
    {"priority": "P1", "region": "CL", "flow": "checkout abandoned (2026 NEW)", "category": "Draft", "issue": "Draft 与 Live Checkout 并存", "action": "合并或下线 Draft 版本"},
    {"priority": "P2", "region": "US", "flow": "Growave - Points Expiration", "category": "Other", "issue": "近 30 天 GMV 极低", "action": "评估降频或合并"},
    {"priority": "P2", "region": "EU", "flow": "Sunset Unengaged Subscribers", "category": "Sunset", "issue": "打开 1.4%（预期偏低）", "action": "仅监控 list 健康"},
    {"priority": "P2", "region": "UK", "flow": "Sunset Unengaged Subscribers", "category": "Sunset", "issue": "打开 1.5%（预期偏低）", "action": "仅监控 list 健康"},
]


def strip_internal(site_why: dict) -> dict:
    out = {}
    for code, block in site_why.items():
        out[code] = {k: v for k, v in block.items() if k != "pattern"}
    return out


def collect_seed_flows(block: dict, regional_alerts: list[dict]) -> list[tuple]:
    flows: dict[str, tuple] = {}
    for item in block.get("flowBest", []) + block.get("flowWorst", []):
        m = item.get("metrics") or {}
        flows[item["name"]] = (
            item["name"],
            int(m.get("recipients", 500)),
            float(m.get("openRate", 0.35)),
            float(m.get("clickRate", 0.03)),
            float(m.get("convRate", 0.01)),
            float(m.get("gmv", 5000)),
            "live",
        )
    for alert in regional_alerts:
        name = alert["flow"]
        if name in flows:
            continue
        status = "draft" if alert.get("category") == "Draft" else "live"
        flows[name] = (name, 500, 0.25, 0.02, 0.005, 1000, status)
    return list(flows.values())


def build_seed_flow_insights(site_why: dict, alerts: list[dict], currency_by_region: dict[str, str]) -> tuple[dict, list[dict]]:
    flow_insights: dict = {}
    flow_index: list[dict] = []
    for code in SITE_ORDER:
        block = site_why.get(code)
        if not block:
            continue
        ccy = currency_by_region.get(code, "USD")
        regional_alerts = [a for a in alerts if a["region"] == code]
        flows = collect_seed_flows(block, regional_alerts)
        for item in build_flow_insights(flows, code, ccy, block, regional_alerts):
            flow_insights[item["id"]] = item
            flow_index.append(item)
    flow_index.sort(key=lambda x: (x["metrics"]["gmv"], x["metrics"]["recipients"]), reverse=True)
    return flow_insights, flow_index


def main() -> None:
    raw_why = json.loads(SEED_WHY.read_text(encoding="utf-8"))
    site_why = strip_internal(raw_why)

    total_campaign = sum(r["campaignGmvCny"] for r in ROWS)
    total_flow = sum(r["flowGmvCny"] for r in ROWS)
    total_gmv = total_campaign + total_flow
    delivered = sum(r["campaign"]["delivered"] + r["flow"]["delivered"] for r in ROWS)
    open_w = sum(
        r["campaign"]["openRate"] * r["campaign"]["delivered"]
        + r["flow"]["openRate"] * r["flow"]["delivered"]
        for r in ROWS
    )
    click_w = sum(
        r["campaign"]["clickRate"] * r["campaign"]["delivered"]
        + r["flow"]["clickRate"] * r["flow"]["delivered"]
        for r in ROWS
    )
    conv = sum(r["campaign"]["conversions"] + r["flow"]["conversions"] for r in ROWS)
    d = delivered or 1
    currency_by_region = {r["region"]: r["currency"] for r in ROWS}
    flow_insights, flow_index = build_seed_flow_insights(site_why, FLOW_ALERTS, currency_by_region)

    payload = {
        "meta": {
            "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "period": "近 30 天",
            "timeframe": TIMEFRAME,
            "siteCount": len(ROWS),
            "errors": [],
            "seed": True,
        },
        "totals": {
            "campaignCny": total_campaign,
            "flowCny": total_flow,
            "gmvCny": total_gmv,
            "campaignShare": total_campaign / total_gmv if total_gmv else 0,
            "flowShare": total_flow / total_gmv if total_gmv else 0,
            "global": {
                "deliveryRate": 0.99,
                "openRate": open_w / d,
                "clickRate": click_w / d,
                "convRate": conv / d,
                "gmvCny": total_gmv,
            },
        },
        "siteOrder": SITE_ORDER,
        "rows": ROWS,
        "siteWhy": site_why,
        "successPlaybook": SUCCESS_PLAYBOOK,
        "failurePlaybook": FAILURE_PLAYBOOK,
        "flowAlerts": FLOW_ALERTS,
        "flowInsights": flow_insights,
        "flowIndex": flow_index,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
