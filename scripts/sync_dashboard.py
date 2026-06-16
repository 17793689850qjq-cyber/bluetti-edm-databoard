#!/usr/bin/env python3
"""Sync Klaviyo dashboard data for all regions → dashboard/data/*.json"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from klaviyo_config import (
    API_REVISION,
    DEFAULT_DAYS,
    FAILURE_PLAYBOOK,
    REGIONS,
    SITE_ORDER,
    SUCCESS_PLAYBOOK,
    RegionConfig,
    api_key_for,
    comparison_periods,
    dashboard_filename,
    dashboard_filenames,
    klaviyo_timeframe,
    period_meta,
)
from analyze_flow_yoy import MIN_DELIVERED, compare_flows_dashboard, aggregate_by_flow_id
from comparisons import build_comparisons
from entity_cache import EntityCache
from ranking import (
    build_flow_alerts,
    build_flow_insights,
    build_site_playbook,
    flow_alert_sort_key,
    rank_items,
    to_flow_why_item,
    to_why_item,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "dashboard" / "data"
SEED_WHY_PATH = Path(__file__).resolve().parent / "seed_site_why.json"

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

    def __init__(self, api_key: str, timeframe: dict):
        self.api_key = api_key
        self.timeframe = timeframe

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
        payload = self._request("GET", "/metrics/")
        for row in payload.get("data", []):
            if (row.get("attributes") or {}).get("name") == "Placed Order":
                return row["id"]
        raise RuntimeError("Placed Order metric not found")

    def campaign_report(self, metric_id: str) -> list[dict]:
        body = {
            "data": {
                "type": "campaign-values-report",
                "attributes": {
                    "timeframe": self.timeframe,
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
                    "timeframe": self.timeframe,
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
                break
            payload = self._request("POST", next_url, body)
            attrs = payload.get("data", {}).get("attributes", {})
            results.extend(attrs.get("results", []))
            links = payload.get("links") or {}
            nxt = links.get("next")
            if not nxt:
                break
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


def parse_campaign_row(row: dict, cache: EntityCache) -> tuple[tuple, list[str], str]:
    gid = row.get("groupings") or {}
    campaign_id = gid.get("campaign_id") or gid.get("campaign_message_id") or ""
    info = cache.campaign_info(campaign_id) if campaign_id else {"name": "Unknown", "subject": "", "status": "Sent", "audiences": []}
    stats = row["statistics"]
    audiences = info.get("audiences") or []
    item = (
        info["name"],
        float(stats.get("recipients") or 0),
        float(stats.get("open_rate") or 0),
        float(stats.get("click_rate") or 0),
        float(stats.get("conversion_rate") or 0),
        float(stats.get("conversion_value") or 0),
        info.get("status") or "Sent",
    )
    subject = info.get("subject") or info["name"]
    return item, audiences, subject


def aggregate_flows(rows: list[dict], cache: EntityCache) -> list[tuple]:
    buckets: dict[str, dict] = {}
    for row in rows:
        gid = row.get("groupings") or {}
        flow_id = gid.get("flow_id") or ""
        info = cache.flow_info(flow_id) if flow_id else {"name": "Flow", "status": "live"}
        name = info["name"]
        status = info.get("status") or "live"
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


def load_seed_why() -> dict:
    if SEED_WHY_PATH.exists():
        return json.loads(SEED_WHY_PATH.read_text(encoding="utf-8"))
    return {}


def sync_region(region: RegionConfig, seed_why: dict, client: KlaviyoClient, period_label: str) -> dict:
    cache = EntityCache(client)
    metric_id = region.metric_id or client.resolve_placed_order_metric()
    time.sleep(1)

    camp_rows = client.campaign_report(metric_id)
    time.sleep(1)
    flow_rows = client.flow_report(metric_id)

    campaigns: list[tuple] = []
    campaign_meta: dict[str, dict] = {}
    for row in camp_rows:
        item, audiences, subject = parse_campaign_row(row, cache)
        campaigns.append(item)
        campaign_meta[item[0]] = {"audiences": audiences, "subject": subject}

    flows = aggregate_flows(flow_rows, cache)
    ccy = region.currency
    seed_block = seed_why.get(region.code) or {}

    cb, cw, _cs = rank_items(campaigns, "campaign", min_rec=1000)
    fb, fw, fs = rank_items(flows, "flow", min_rec=200)

    site_why = {
        "summary": seed_block.get("summary") or f"{len(campaigns)} Campaign · {len(flows)} Flow · {period_label}",
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
    flow_alerts = build_flow_alerts(flows, region.code, ccy)

    return {
        "region": region.code,
        "currency": ccy,
        "campaign": camp_agg,
        "flow": flow_agg,
        "campaignGmvCny": round(camp_agg["gmv"] * region.fx_to_cny, 0),
        "flowGmvCny": round(flow_agg["gmv"] * region.fx_to_cny, 0),
        "siteWhy": site_why,
        "sitePlaybook": build_site_playbook(
            region.code,
            site_why,
            seed_block,
            ccy=ccy,
            camp_avg=camp_agg,
            flow_avg=flow_agg,
        ),
        "flowAlerts": flow_alerts,
        "flowInsights": build_flow_insights(flows, region.code, ccy, site_why, flow_alerts),
    }


def sync_region_totals(region: RegionConfig, client: KlaviyoClient) -> dict:
    """Lightweight region sync for comparison periods (aggregates only)."""
    metric_id = region.metric_id or client.resolve_placed_order_metric()
    time.sleep(1)
    camp_rows = client.campaign_report(metric_id)
    time.sleep(1)
    flow_rows = client.flow_report(metric_id)
    camp_agg = agg_metrics(camp_rows) if camp_rows else _empty_metrics()
    flow_agg = agg_metrics(flow_rows) if flow_rows else _empty_metrics()
    campaign_gmv_cny = round(camp_agg["gmv"] * region.fx_to_cny, 0)
    flow_gmv_cny = round(flow_agg["gmv"] * region.fx_to_cny, 0)
    return {
        "region": region.code,
        "currency": region.currency,
        "campaign": camp_agg,
        "flow": flow_agg,
        "campaignGmvCny": campaign_gmv_cny,
        "flowGmvCny": flow_gmv_cny,
        "totalGmvCny": campaign_gmv_cny + flow_gmv_cny,
    }


def fetch_comparison_rows(timeframe: dict, label: str) -> tuple[list[dict], list[str]]:
    rows: list[dict] = []
    errors: list[str] = []
    for region in REGIONS:
        key = api_key_for(region)
        if not key:
            continue
        try:
            client = KlaviyoClient(key, timeframe)
            data = sync_region_totals(region, client)
            rows.append(data)
            print(f"OK {region.code} ({label})", file=sys.stderr)
        except Exception as e:
            msg = f"{region.code} [{label}]: {e}"
            errors.append(msg)
            print(f"SKIP {msg}", file=sys.stderr)
    rows.sort(key=lambda r: SITE_ORDER.index(r["region"]) if r["region"] in SITE_ORDER else 99)
    return rows, errors


def totals_from_rows(rows: list[dict]) -> dict:
    total_campaign = sum(r["campaignGmvCny"] for r in rows)
    total_flow = sum(r["flowGmvCny"] for r in rows)
    total_gmv = total_campaign + total_flow
    delivered = sum(r["campaign"]["delivered"] + r["flow"]["delivered"] for r in rows)
    open_w = sum(
        r["campaign"]["openRate"] * r["campaign"]["delivered"]
        + r["flow"]["openRate"] * r["flow"]["delivered"]
        for r in rows
    )
    click_w = sum(
        r["campaign"]["clickRate"] * r["campaign"]["delivered"]
        + r["flow"]["clickRate"] * r["flow"]["delivered"]
        for r in rows
    )
    conv = sum(r["campaign"]["conversions"] + r["flow"]["conversions"] for r in rows)
    d = delivered or 1
    return {
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
    }


FLOW_YOY_TOP_N = 50
FLOW_YOY_PRESETS = {"30d"}


def fetch_region_flow_buckets(region: RegionConfig, timeframe: dict, label: str) -> dict[str, dict] | None:
    key = api_key_for(region)
    if not key:
        return None
    try:
        client = KlaviyoClient(key, timeframe)
        cache = EntityCache(client)
        metric_id = region.metric_id or client.resolve_placed_order_metric()
        time.sleep(1)
        flow_rows = client.flow_report(metric_id)
        buckets = aggregate_by_flow_id(flow_rows, cache)
        print(f"OK {region.code} flow YoY [{label}] ({len(buckets)} flows)", file=sys.stderr)
        return buckets
    except Exception as e:
        print(f"SKIP {region.code} flow YoY [{label}]: {e}", file=sys.stderr)
        return None


def attach_flow_yoy(
    comparisons: dict,
    period: dict,
    current_timeframe: dict,
    *,
    min_delivered: int = MIN_DELIVERED,
    top_n: int = FLOW_YOY_TOP_N,
) -> dict:
    """Fetch per-flow current vs YoY rows; only for supported presets (30d)."""
    preset = period.get("preset")
    if preset not in FLOW_YOY_PRESETS:
        return comparisons

    ranges = comparison_periods(period)
    yoy_tf = klaviyo_timeframe(start=ranges["yoy"]["start"], end=ranges["yoy"]["end"])
    sites_out: dict[str, list[dict]] = {}
    errors: list[str] = []

    for region in REGIONS:
        key = api_key_for(region)
        if not key:
            continue
        cur_buckets = fetch_region_flow_buckets(region, current_timeframe, "current")
        time.sleep(1)
        yoy_buckets = fetch_region_flow_buckets(region, yoy_tf, "yoy")
        if cur_buckets is None and yoy_buckets is None:
            errors.append(f"{region.code}: flow YoY fetch failed")
            continue
        rows = compare_flows_dashboard(
            cur_buckets or {},
            yoy_buckets or {},
            fx_to_cny=region.fx_to_cny,
            min_delivered=min_delivered,
            top_n=top_n,
        )
        if rows:
            sites_out[region.code] = rows

    if sites_out:
        comparisons["flowYoY"] = {
            "meta": {
                "minDelivered": min_delivered,
                "topN": top_n,
                "yoyPeriod": ranges["yoy"],
            },
            "sites": sites_out,
        }
    if errors:
        comparisons.setdefault("flowYoYErrors", errors)
    return comparisons


def attach_comparisons(dashboard: dict, period: dict, *, enabled: bool = True) -> dict:
    if not enabled:
        return dashboard
    ranges = comparison_periods(period)
    mom_tf = klaviyo_timeframe(start=ranges["mom"]["start"], end=ranges["mom"]["end"])
    yoy_tf = klaviyo_timeframe(start=ranges["yoy"]["start"], end=ranges["yoy"]["end"])

    mom_rows, mom_errors = fetch_comparison_rows(mom_tf, "MoM")
    yoy_rows, yoy_errors = fetch_comparison_rows(yoy_tf, "YoY")

    mom_totals = totals_from_rows(mom_rows) if mom_rows else None
    yoy_totals = totals_from_rows(yoy_rows) if yoy_rows else None

    comparisons = build_comparisons(
        dashboard["totals"],
        mom_totals,
        yoy_totals,
        dashboard["rows"],
        mom_rows or None,
        yoy_rows or None,
        period_meta=period,
        mom_period=ranges["mom"],
        yoy_period=ranges["yoy"],
    )
    current_tf = dashboard.get("meta", {}).get("timeframe") or klaviyo_timeframe(days=period.get("days"))
    print("Fetching per-flow YoY comparison data…", file=sys.stderr)
    attach_flow_yoy(comparisons, period, current_tf)
    dashboard["comparisons"] = comparisons
    if mom_errors or yoy_errors:
        dashboard["meta"].setdefault("errors", [])
        dashboard["meta"]["errors"].extend(mom_errors + yoy_errors)
    return dashboard


def build_dashboard(timeframe: dict, period: dict) -> dict:
    rows: list[dict] = []
    site_why: dict = {}
    site_playbook: dict = {}
    flow_alerts: list[dict] = []
    flow_insights: dict = {}
    flow_index: list[dict] = []
    errors: list[str] = []
    seed_why = load_seed_why()
    period_label = period["label"]

    for region in REGIONS:
        key = api_key_for(region)
        if not key:
            errors.append(f"{region.code}: missing API key env {region.api_key_env}")
            continue
        try:
            client = KlaviyoClient(key, timeframe)
            data = sync_region(region, seed_why, client, period_label)
            data["totalGmvCny"] = data["campaignGmvCny"] + data["flowGmvCny"]
            rows.append({k: data[k] for k in ("region", "currency", "campaign", "flow", "campaignGmvCny", "flowGmvCny", "totalGmvCny")})
            site_why[region.code] = data["siteWhy"]
            site_playbook[region.code] = data["sitePlaybook"]
            flow_alerts.extend(data["flowAlerts"])
            for item in data["flowInsights"]:
                flow_insights[item["id"]] = item
                flow_index.append(item)
            print(f"OK {region.code}", file=sys.stderr)
        except Exception as e:
            msg = f"{region.code}: {e}"
            errors.append(msg)
            print(f"SKIP {msg}", file=sys.stderr)

    rows.sort(key=lambda r: SITE_ORDER.index(r["region"]) if r["region"] in SITE_ORDER else 99)

    total_campaign = sum(r["campaignGmvCny"] for r in rows)
    total_flow = sum(r["flowGmvCny"] for r in rows)
    total_gmv = total_campaign + total_flow

    delivered = sum(r["campaign"]["delivered"] + r["flow"]["delivered"] for r in rows)
    open_w = sum(r["campaign"]["openRate"] * r["campaign"]["delivered"] + r["flow"]["openRate"] * r["flow"]["delivered"] for r in rows)
    click_w = sum(r["campaign"]["clickRate"] * r["campaign"]["delivered"] + r["flow"]["clickRate"] * r["flow"]["delivered"] for r in rows)
    conv = sum(r["campaign"]["conversions"] + r["flow"]["conversions"] for r in rows)
    d = delivered or 1

    flow_alerts.sort(key=flow_alert_sort_key)
    flow_index.sort(key=lambda x: (x["metrics"]["gmv"], x["metrics"]["recipients"]), reverse=True)

    return {
        "meta": {
            "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "period": period,
            "timeframe": timeframe,
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
        "sitePlaybook": site_playbook,
        "flowInsights": flow_insights,
        "flowIndex": flow_index,
        "successPlaybook": SUCCESS_PLAYBOOK,
        "failurePlaybook": FAILURE_PLAYBOOK,
        "flowAlerts": flow_alerts,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sync Klaviyo dashboard JSON for a date range.")
    p.add_argument("--days", type=int, help="Preset lookback days (7, 30, 60, 90)")
    p.add_argument("--start", help="Custom range start YYYY-MM-DD")
    p.add_argument("--end", help="Custom range end YYYY-MM-DD")
    p.add_argument("--out", help="Output path (default: dashboard/data/<period>.json)")
    p.add_argument("--skip-comparisons", action="store_true", help="Skip MoM/YoY API fetches")
    return p.parse_args(argv)


def resolve_sync_window(args: argparse.Namespace) -> tuple[dict, dict]:
    if args.start or args.end:
        if not (args.start and args.end):
            raise SystemExit("Custom range requires both --start and --end")
        timeframe = klaviyo_timeframe(start=args.start, end=args.end)
        period = period_meta(start=args.start, end=args.end)
    else:
        days = args.days if args.days is not None else DEFAULT_DAYS
        timeframe = klaviyo_timeframe(days=days)
        period = period_meta(days=days)
    return timeframe, period


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    timeframe, period = resolve_sync_window(args)
    out_path = Path(args.out) if args.out else DATA_DIR / dashboard_filename(period)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    dashboard = build_dashboard(timeframe, period)
    if not dashboard["rows"]:
        print("No API keys or all regions failed; using seed snapshot", file=sys.stderr)
        import build_seed_dashboard

        for name in dashboard_filenames(period) if not args.out else [out_path.name]:
            build_seed_dashboard.main(
                days=period.get("days", DEFAULT_DAYS),
                out_path=DATA_DIR / name,
                period=period,
            )
        return 0

    with_comparisons = not args.skip_comparisons
    if with_comparisons:
        print("Fetching MoM / YoY comparison data…", file=sys.stderr)
        attach_comparisons(dashboard, period, enabled=True)

    payload = json.dumps(dashboard, ensure_ascii=False, indent=2)
    targets = [out_path] if args.out else [DATA_DIR / n for n in dashboard_filenames(period)]
    for target in targets:
        target.write_text(payload, encoding="utf-8")
        print(f"Wrote {target} ({dashboard['meta']['siteCount']} sites, {period['label']})")
    if dashboard["meta"]["errors"]:
        print("Partial errors:", dashboard["meta"]["errors"], file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
