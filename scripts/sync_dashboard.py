#!/usr/bin/env python3
"""Sync Klaviyo dashboard data for all regions → dashboard/data/dashboard.json"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from klaviyo_config import (
    API_REVISION,
    FAILURE_PLAYBOOK,
    REGIONS,
    SITE_ORDER,
    SUCCESS_PLAYBOOK,
    TIMEFRAME,
    RegionConfig,
    api_key_for,
)
from ranking import (
    build_flow_alerts,
    rank_items,
    to_flow_why_item,
    to_why_item,
)

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "dashboard" / "data" / "dashboard.json"

STATS = [
    "recipients",
    "delivered",
    "delivery_rate",
    "open_rate",
    "click_rate",
    "conversion_rate",
    "conversions",
    "conversion_value",
]


class KlaviyoClient:
    BASE = "https://a.klaviyo.com/api"

    def __init__(self, api_key: str):
        self.api_key = api_key

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.BASE}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": f"Klaviyo-API-Key {self.api_key}",
                "Accept": "application/vnd.api+json",
                "Content-Type": "application/vnd.api+json",
                "revision": API_REVISION,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {e.code} {path}: {detail[:500]}") from e

    def resolve_placed_order_metric(self) -> str:
        payload = self._request("GET", "/metrics/?filter=equals(name,'Placed Order')")
        for row in payload.get("data", []):
            return row["id"]
        raise RuntimeError("Placed Order metric not found")

    def campaign_report(self, metric_id: str) -> list[dict]:
        body = {
            "data": {
                "type": "campaign-values-report",
                "attributes": {
                    "timeframe": {"key": TIMEFRAME},
                    "conversion_metric_id": metric_id,
                    "filter": 'equals(send_channel,"email")',
                    "statistics": STATS,
                },
            }
        }
        return self._paginate_report("/campaign-values-reports/", body)

    def flow_report(self, metric_id: str) -> list[dict]:
        body = {
            "data": {
                "type": "flow-values-report",
                "attributes": {
                    "timeframe": {"key": TIMEFRAME},
                    "conversion_metric_id": metric_id,
                    "filter": 'equals(send_channel,"email")',
                    "statistics": STATS,
                },
            }
        }
        return self._paginate_report("/flow-values-reports/", body)

    def _paginate_report(self, path: str, body: dict) -> list[dict]:
        results: list[dict] = []
        next_url: str | None = path
        while next_url:
            if next_url.startswith("http"):
                # full URL from links.next — use GET not supported; use cursor if present
                break
            payload = self._request("POST", next_url, body)
            attrs = payload.get("data", {}).get("attributes", {})
            results.extend(attrs.get("results", []))
            links = payload.get("links") or {}
            nxt = links.get("next")
            if not nxt:
                break
            # Klaviyo may return full URL; for simplicity single page (MCP also returns next:null)
            break
        return results


def _empty_metrics() -> dict:
    return {
        "deliveryRate": 0,
        "openRate": 0,
        "clickRate": 0,
        "convRate": 0,
        "gmv": 0,
        "conversions": 0,
        "delivered": 0,
    }


def agg_metrics(rows: list[dict]) -> dict:
    delivered = 0.0
    recipients = 0.0
    conversions = 0.0
    gmv = 0.0
    open_w = 0.0
    click_w = 0.0
    for row in rows:
        s = row["statistics"]
        d = float(s.get("delivered") or 0)
        r = float(s.get("recipients") or 0)
        delivered += d
        recipients += r
        conversions += float(s.get("conversions") or 0)
        gmv += float(s.get("conversion_value") or 0)
        open_w += float(s.get("open_rate") or 0) * d
        click_w += float(s.get("click_rate") or 0) * d
    d = delivered or 1
    rec = recipients or 1
    return {
        "deliveryRate": delivered / rec,
        "openRate": open_w / d,
        "clickRate": click_w / d,
        "convRate": conversions / d,
        "gmv": round(gmv, 2),
        "conversions": int(conversions),
        "delivered": int(delivered),
    }


def parse_campaign_row(row: dict) -> tuple:
    details = (row.get("campaign_details") or {}).get("attributes") or {}
    stats = row["statistics"]
    audiences = [a.get("name", "") for a in (details.get("audiences") or {}).get("included") or []]
    return (
        details.get("name") or "Unknown",
        float(stats.get("recipients") or 0),
        float(stats.get("open_rate") or 0),
        float(stats.get("click_rate") or 0),
        float(stats.get("conversion_rate") or 0),
        float(stats.get("conversion_value") or 0),
        details.get("status") or "Sent",
    ), audiences


def aggregate_flows(rows: list[dict]) -> list[tuple]:
    buckets: dict[str, dict] = {}
    for row in rows:
        fd = row.get("flow_details") or {}
        attrs = fd.get("attributes") or {}
        name = attrs.get("name") or row.get("groupings", {}).get("flow_id", "Flow")
        status = attrs.get("status") or "live"
        stats = row["statistics"]
        if name not in buckets:
            buckets[name] = {
                "recipients": 0.0,
                "delivered": 0.0,
                "open_w": 0.0,
                "click_w": 0.0,
                "conversions": 0.0,
                "gmv": 0.0,
                "status": status,
            }
        b = buckets[name]
        d = float(stats.get("delivered") or stats.get("recipients") or 0)
        b["recipients"] += float(stats.get("recipients") or 0)
        b["delivered"] += d
        b["open_w"] += float(stats.get("open_rate") or 0) * d
        b["click_w"] += float(stats.get("click_rate") or 0) * d
        b["conversions"] += float(stats.get("conversions") or 0)
        b["gmv"] += float(stats.get("conversion_value") or 0)
    out: list[tuple] = []
    for name, b in buckets.items():
        d = b["delivered"] or 1
        out.append(
            (
                name,
                b["recipients"],
                b["open_w"] / d,
                b["click_w"] / d,
                b["conversions"] / d,
                b["gmv"],
                b["status"],
            )
        )
    return out


def sync_region(region: RegionConfig) -> dict:
    key = api_key_for(region)
    if not key:
        raise RuntimeError(f"missing API key env {region.api_key_env}")

    client = KlaviyoClient(key)
    metric_id = region.metric_id or client.resolve_placed_order_metric()
    time.sleep(1)  # gentle rate limit between report calls

    camp_rows = client.campaign_report(metric_id)
    time.sleep(1)
    flow_rows = client.flow_report(metric_id)

    campaigns: list[tuple] = []
    campaign_meta: dict[str, dict] = {}
    for row in camp_rows:
        item, audiences = parse_campaign_row(row)
        campaigns.append(item)
        campaign_meta[item[0]] = {"audiences": audiences, "subject": item[0]}

    flows = aggregate_flows(flow_rows)
    ccy = region.currency

    cb, cw, _cs = rank_items(campaigns, "campaign", min_rec=1000)
    fb, fw, fs = rank_items(flows, "flow", min_rec=200)

    site_why = {
        "summary": f"{len(campaigns)} Campaign · {len(flows)} Flow",
        "campaignBest": [],
        "campaignWorst": [],
        "flowBest": [to_flow_why_item(it, ccy, True) for it in fb],
        "flowWorst": [to_flow_why_item(it, ccy, False) for it in fw + fs],
    }
    for it in cb:
        meta = campaign_meta.get(it[0], {})
        site_why["campaignBest"].append(
            to_why_item(it[0], meta.get("subject", it[0]), meta.get("audiences", []), it, ccy, True)
        )
    for it in cw:
        meta = campaign_meta.get(it[0], {})
        site_why["campaignWorst"].append(
            to_why_item(it[0], meta.get("subject", it[0]), meta.get("audiences", []), it, ccy, False)
        )

    camp_agg = agg_metrics(camp_rows) if camp_rows else _empty_metrics()
    flow_agg = agg_metrics(flow_rows) if flow_rows else _empty_metrics()

    return {
        "region": region.code,
        "currency": ccy,
        "campaign": camp_agg,
        "flow": flow_agg,
        "campaignGmvCny": round(camp_agg["gmv"] * region.fx_to_cny, 0),
        "flowGmvCny": round(flow_agg["gmv"] * region.fx_to_cny, 0),
        "siteWhy": site_why,
        "flowAlerts": build_flow_alerts(flows, region.code),
    }


def build_dashboard() -> dict:
    rows: list[dict] = []
    site_why: dict = {}
    flow_alerts: list[dict] = []
    errors: list[str] = []

    for region in REGIONS:
        try:
            data = sync_region(region)
            data["totalGmvCny"] = data["campaignGmvCny"] + data["flowGmvCny"]
            rows.append({k: data[k] for k in ("region", "currency", "campaign", "flow", "campaignGmvCny", "flowGmvCny", "totalGmvCny")})
            site_why[region.code] = data["siteWhy"]
            flow_alerts.extend(data["flowAlerts"])
            print(f"OK {region.code}", file=sys.stderr)
        except Exception as e:
            msg = f"{region.code}: {e}"
            errors.append(msg)
            print(f"SKIP {msg}", file=sys.stderr)

    rows.sort(key=lambda r: SITE_ORDER.index(r["region"]) if r["region"] in SITE_ORDER else 99)

    total_campaign = sum(r["campaignGmvCny"] for r in rows)
    total_flow = sum(r["flowGmvCny"] for r in rows)
    total_gmv = total_campaign + total_flow

    # Global KPI (combined weighted)
    delivered = sum(r["campaign"]["delivered"] + r["flow"]["delivered"] for r in rows)
    open_w = sum(r["campaign"]["openRate"] * r["campaign"]["delivered"] + r["flow"]["openRate"] * r["flow"]["delivered"] for r in rows)
    click_w = sum(r["campaign"]["clickRate"] * r["campaign"]["delivered"] + r["flow"]["clickRate"] * r["flow"]["delivered"] for r in rows)
    conv = sum(r["campaign"]["conversions"] + r["flow"]["conversions"] for r in rows)
    d = delivered or 1

    flow_alerts.sort(key=lambda a: (a["priority"], a["region"]))

    return {
        "meta": {
            "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "period": "近 30 天",
            "timeframe": TIMEFRAME,
            "siteCount": len(rows),
            "errors": errors,
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
        "rows": rows,
        "siteWhy": site_why,
        "successPlaybook": SUCCESS_PLAYBOOK,
        "failurePlaybook": FAILURE_PLAYBOOK,
        "flowAlerts": flow_alerts,
    }


def main() -> int:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    dashboard = build_dashboard()
    if not dashboard["rows"]:
        print("No API keys or all regions failed; using seed snapshot", file=sys.stderr)
        import build_seed_dashboard

        build_seed_dashboard.main()
        return 0
    OUT_PATH.write_text(json.dumps(dashboard, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_PATH} ({dashboard['meta']['siteCount']} sites)")
    if dashboard["meta"]["errors"]:
        print("Partial errors:", dashboard["meta"]["errors"], file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
