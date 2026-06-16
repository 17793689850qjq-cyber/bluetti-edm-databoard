#!/usr/bin/env python3
"""Per-flow YoY analysis: aggregate flow-values-report rows by flow_id."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from klaviyo_config import REGIONS  # noqa: E402

if TYPE_CHECKING:
    from entity_cache import EntityCache

MIN_DELIVERED = 200
DEFAULT_TOP_N = 50


def aggregate_by_flow_id(rows: list[dict], cache: "EntityCache") -> dict[str, dict]:
    """Aggregate Klaviyo flow report rows by flow_id; resolve names via entity_cache."""
    buckets: dict[str, dict] = {}
    for row in rows:
        gid = row.get("groupings") or {}
        flow_id = gid.get("flow_id") or ""
        if not flow_id:
            continue
        info = cache.flow_info(flow_id)
        name = info.get("name") or flow_id
        status = info.get("status") or "live"
        stats = row.get("statistics") or {}

        d = float(stats.get("delivered") or 0)
        if flow_id not in buckets:
            buckets[flow_id] = {
                "flow_id": flow_id,
                "name": name,
                "status": status,
                "delivered": 0.0,
                "conversions": 0.0,
                "open_w": 0.0,
                "click_w": 0.0,
                "gmv": 0.0,
            }
        b = buckets[flow_id]
        b["name"] = name
        b["status"] = status
        b["delivered"] += d
        b["conversions"] += float(stats.get("conversions") or 0)
        b["open_w"] += float(stats.get("open_rate") or 0) * d
        b["click_w"] += float(stats.get("click_rate") or 0) * d
        b["gmv"] += float(stats.get("conversion_value") or 0)
    for b in buckets.values():
        d = b["delivered"] or 1
        b["conv_rate"] = b["conversions"] / d
        b["open_rate"] = b["open_w"] / d
        b["click_rate"] = b["click_w"] / d
    return buckets


def aggregate_by_flow(results: list[dict]) -> dict[str, dict]:
    """Legacy: aggregate from saved MCP JSON (uses flow_details in payload)."""
    buckets: dict[str, dict] = {}
    for row in results:
        gid = row.get("groupings") or {}
        flow_id = gid.get("flow_id") or ""
        if not flow_id:
            continue
        stats = row.get("statistics") or {}
        details = row.get("flow_details") or {}
        attrs = (details.get("attributes") or {}) if details else {}
        name = attrs.get("name") or flow_id
        status = attrs.get("status") or "live"

        d = float(stats.get("delivered") or 0)
        if flow_id not in buckets:
            buckets[flow_id] = {
                "flow_id": flow_id,
                "name": name,
                "status": status,
                "delivered": 0.0,
                "conversions": 0.0,
                "open_w": 0.0,
                "click_w": 0.0,
                "gmv": 0.0,
            }
        b = buckets[flow_id]
        b["name"] = name
        b["status"] = status
        b["delivered"] += d
        b["conversions"] += float(stats.get("conversions") or 0)
        b["open_w"] += float(stats.get("open_rate") or 0) * d
        b["click_w"] += float(stats.get("click_rate") or 0) * d
        b["gmv"] += float(stats.get("conversion_value") or 0)
    for b in buckets.values():
        d = b["delivered"] or 1
        b["conv_rate"] = b["conversions"] / d
        b["open_rate"] = b["open_w"] / d
        b["click_rate"] = b["click_w"] / d
    return buckets


def _period_snapshot(block: dict | None, fx_to_cny: float) -> dict | None:
    if not block:
        return None
    gmv = round(block.get("gmv", 0), 2)
    return {
        "delivered": int(block.get("delivered", 0)),
        "conversions": int(block.get("conversions", 0)),
        "convRate": block.get("conv_rate", 0),
        "openRate": block.get("open_rate", 0),
        "clickRate": block.get("click_rate", 0),
        "gmv": gmv,
        "gmvCny": round(gmv * fx_to_cny, 0),
    }


def compare_flows_dashboard(
    cur: dict[str, dict],
    yoy: dict[str, dict],
    *,
    fx_to_cny: float = 1.0,
    min_delivered: int = MIN_DELIVERED,
    top_n: int = DEFAULT_TOP_N,
) -> list[dict]:
    """Match flows by flow_id and return dashboard-ready YoY rows."""
    all_ids = set(cur) | set(yoy)
    rows: list[dict] = []
    for fid in all_ids:
        c = cur.get(fid)
        y = yoy.get(fid)
        if not c and not y:
            continue
        cur_d = (c or {}).get("delivered", 0)
        yoy_d = (y or {}).get("delivered", 0)
        if cur_d < min_delivered and yoy_d < min_delivered:
            continue
        cur_conv = (c or {}).get("conv_rate", 0)
        yoy_conv = (y or {}).get("conv_rate", 0)
        cur_gmv = (c or {}).get("gmv", 0)
        yoy_gmv = (y or {}).get("gmv", 0)
        name = (c or y or {}).get("name", fid)
        status = (c or y or {}).get("status", "")
        delivered_chg = (cur_d - yoy_d) / yoy_d if yoy_d else None
        conv_rate_chg = cur_conv - yoy_conv
        conv_rate_pct = (cur_conv - yoy_conv) / yoy_conv if yoy_conv else None
        gmv_chg = (cur_gmv - yoy_gmv) / yoy_gmv if yoy_gmv else None
        rows.append(
            {
                "flowId": fid,
                "name": name,
                "status": status,
                "current": _period_snapshot(c, fx_to_cny),
                "yoy": _period_snapshot(y, fx_to_cny),
                "deltas": {
                    "deliveredPct": delivered_chg,
                    "convRateDelta": conv_rate_chg,
                    "convRatePct": conv_rate_pct,
                    "gmvPct": gmv_chg,
                    "gmvCnyPct": gmv_chg,
                },
                "inCurrent": c is not None,
                "inYoy": y is not None,
            }
        )
    rows.sort(key=lambda r: max((r["current"] or {}).get("delivered", 0), (r["yoy"] or {}).get("delivered", 0)), reverse=True)
    return rows[:top_n]


def compare_flows(cur: dict[str, dict], yoy: dict[str, dict], region: str) -> list[dict]:
    """CLI-oriented comparison rows (legacy)."""
    all_ids = set(cur) | set(yoy)
    rows: list[dict] = []
    for fid in all_ids:
        c = cur.get(fid)
        y = yoy.get(fid)
        if not c and not y:
            continue
        cur_d = (c or {}).get("delivered", 0)
        yoy_d = (y or {}).get("delivered", 0)
        cur_conv = (c or {}).get("conv_rate", 0)
        yoy_conv = (y or {}).get("conv_rate", 0)
        cur_convs = (c or {}).get("conversions", 0)
        yoy_convs = (y or {}).get("conversions", 0)
        name = (c or y or {}).get("name", fid)
        status = (c or y or {}).get("status", "")
        delivered_chg = (cur_d - yoy_d) / yoy_d if yoy_d else None
        conv_rate_chg = cur_conv - yoy_conv
        conv_rate_pct = (cur_conv - yoy_conv) / yoy_conv if yoy_conv else None
        rows.append(
            {
                "region": region,
                "flow_id": fid,
                "name": name,
                "status": status,
                "cur_delivered": cur_d,
                "yoy_delivered": yoy_d,
                "delivered_chg_pct": delivered_chg,
                "cur_conv_rate": cur_conv,
                "yoy_conv_rate": yoy_conv,
                "conv_rate_chg": conv_rate_chg,
                "conv_rate_chg_pct": conv_rate_pct,
                "cur_conversions": cur_convs,
                "yoy_conversions": yoy_convs,
                "cur_open_rate": (c or {}).get("open_rate"),
                "yoy_open_rate": (y or {}).get("open_rate"),
                "cur_click_rate": (c or {}).get("click_rate"),
                "yoy_click_rate": (y or {}).get("click_rate"),
                "in_current": c is not None,
                "in_yoy": y is not None,
            }
        )
    return rows


def load_report(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("data", {}).get("attributes", {}).get("results", [])


def fmt_pct(x: float | None, signed: bool = True) -> str:
    if x is None:
        return "—"
    sign = "+" if x > 0 and signed else ""
    return f"{sign}{x * 100:.1f}%"


def fmt_rate(x: float) -> str:
    return f"{x * 100:.2f}%"


def print_report(rows: list[dict], *, title: str, min_delivered: int = MIN_DELIVERED) -> None:
    eligible = [r for r in rows if r["cur_delivered"] >= min_delivered or r["yoy_delivered"] >= min_delivered]
    print(f"\n{'=' * 60}")
    print(title)
    print(f"{'=' * 60}")

    drops = sorted(
        [r for r in eligible if r["in_current"] and r["in_yoy"] and r["conv_rate_chg"] < 0],
        key=lambda r: r["conv_rate_chg"],
    )[:10]
    print("\n【转化率同比下降 Top】")
    for r in drops:
        print(
            f"  {r['region']} | {r['name']} ({r['status']})"
            f"\n    转化: {fmt_rate(r['yoy_conv_rate'])} → {fmt_rate(r['cur_conv_rate'])}"
            f" ({fmt_pct(r['conv_rate_chg_pct'])})"
            f" | 送达: {int(r['yoy_delivered']):,} → {int(r['cur_delivered']):,}"
            f" ({fmt_pct(r['delivered_chg_pct'])})"
            f" | 转化数: {int(r['yoy_conversions'])} → {int(r['cur_conversions'])}"
        )

    surges = sorted(
        [r for r in eligible if r["in_current"] and r["in_yoy"] and (r["delivered_chg_pct"] or 0) > 0.3],
        key=lambda r: r["delivered_chg_pct"] or 0,
        reverse=True,
    )[:10]
    print("\n【发送量激增（稀释候选）Top】")
    for r in surges:
        dilution = r["conv_rate_chg"] < 0 and (r["delivered_chg_pct"] or 0) > 0.3
        tag = " [稀释]" if dilution else ""
        print(
            f"  {r['region']} | {r['name']}{tag}"
            f"\n    送达: {int(r['yoy_delivered']):,} → {int(r['cur_delivered']):,}"
            f" ({fmt_pct(r['delivered_chg_pct'])})"
            f" | 转化: {fmt_rate(r['yoy_conv_rate'])} → {fmt_rate(r['cur_conv_rate'])}"
        )

    new_flows = [r for r in eligible if r["in_current"] and not r["in_yoy"] and r["cur_delivered"] >= min_delivered]
    if new_flows:
        print("\n【本期新增/去年无数据 Flow】")
        for r in sorted(new_flows, key=lambda x: -x["cur_delivered"])[:8]:
            print(f"  {r['region']} | {r['name']} | 送达 {int(r['cur_delivered']):,} | 转化 {fmt_rate(r['cur_conv_rate'])}")

    gone = [r for r in eligible if r["in_yoy"] and not r["in_current"] and r["yoy_delivered"] >= min_delivered]
    if gone:
        print("\n【去年有、本期无/极低 Flow】")
        for r in sorted(gone, key=lambda x: -x["yoy_delivered"])[:8]:
            print(f"  {r['region']} | {r['name']} | 去年送达 {int(r['yoy_delivered']):,} | 转化 {fmt_rate(r['yoy_conv_rate'])}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Per-flow YoY comparison from saved MCP report JSON")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "scripts" / ".flow_yoy_cache")
    parser.add_argument("--region", default=None, help="Single region code, e.g. US")
    parser.add_argument("--min-delivered", type=int, default=MIN_DELIVERED)
    args = parser.parse_args()

    regions = [r for r in REGIONS if not args.region or r.code == args.region]
    all_rows: list[dict] = []

    for region in regions:
        cur_path = args.data_dir / f"{region.code}_current.json"
        yoy_path = args.data_dir / f"{region.code}_yoy.json"
        if not cur_path.exists() or not yoy_path.exists():
            print(f"skip {region.code}: missing {cur_path.name} or {yoy_path.name}", file=sys.stderr)
            continue
        cur = aggregate_by_flow(load_report(cur_path))
        yoy = aggregate_by_flow(load_report(yoy_path))
        all_rows.extend(compare_flows(cur, yoy, region.code))

    if args.region:
        print_report([r for r in all_rows if r["region"] == args.region], title=f"{args.region} Flow 同比", min_delivered=args.min_delivered)
    if all_rows:
        print_report(all_rows, title="全球 Flow 同比汇总", min_delivered=args.min_delivered)

    matched = [r for r in all_rows if r["in_current"] and r["in_yoy"] and max(r["cur_delivered"], r["yoy_delivered"]) >= args.min_delivered]
    vol_only = [r for r in matched if r["conv_rate_chg"] < 0 and (r["delivered_chg_pct"] or 0) > 0.2 and abs(r.get("cur_open_rate", 0) - (r.get("yoy_open_rate") or 0)) < 0.05]
    engagement = [r for r in matched if r["conv_rate_chg"] < 0 and ((r.get("cur_open_rate") or 0) < (r.get("yoy_open_rate") or 0) - 0.03 or (r.get("cur_click_rate") or 0) < (r.get("yoy_click_rate") or 0) - 0.01)]
    print("\n【归因摘要】")
    print(f"  可比对 Flow 数: {len(matched)}")
    print(f"  转化降 + 量增>20% 且打开率持平: {len(vol_only)}（偏稀释）")
    print(f"  转化降 + 打开/点击明显下滑: {len(engagement)}（偏互动）")
    print(f"  本期新增高量 Flow: {len([r for r in all_rows if r['in_current'] and not r['in_yoy'] and r['cur_delivered'] >= args.min_delivered])}")
    print(f"  去年高量本期消失: {len([r for r in all_rows if r['in_yoy'] and not r['in_current'] and r['yoy_delivered'] >= args.min_delivered])}")


if __name__ == "__main__":
    main()
