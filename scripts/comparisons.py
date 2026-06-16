"""Build YoY / MoM comparison blocks for dashboard JSON."""

from __future__ import annotations

from typing import Any


def _pct_change(current: float, previous: float) -> float | None:
    if previous == 0:
        return None if current == 0 else None
    return (current - previous) / previous


def _delta(current: float, previous: float) -> float:
    return current - previous


def _fmt_pct(x: float | None) -> str | None:
    if x is None:
        return None
    sign = "+" if x > 0 else ""
    return f"{sign}{(x * 100):.1f}%"


def _aggregate_channel(rows: list[dict], channel: str) -> dict[str, Any]:
    """Weighted channel metrics from per-site rows (campaign or flow)."""
    delivered = sum(r[channel]["delivered"] for r in rows)
    d = delivered or 1
    open_w = sum(r[channel]["openRate"] * r[channel]["delivered"] for r in rows)
    click_w = sum(r[channel]["clickRate"] * r[channel]["delivered"] for r in rows)
    conv = sum(r[channel]["conversions"] for r in rows)
    gmv_key = "campaignGmvCny" if channel == "campaign" else "flowGmvCny"
    return {
        "gmvCny": sum(r[gmv_key] for r in rows),
        "gmvLocal": sum(r[channel]["gmv"] for r in rows),
        "openRate": open_w / d,
        "clickRate": click_w / d,
        "convRate": conv / d,
    }


def _totals_snapshot(totals: dict) -> dict[str, Any]:
    return {
        "gmvCny": totals.get("gmvCny", 0),
        "campaignCny": totals.get("campaignCny", 0),
        "flowCny": totals.get("flowCny", 0),
        "campaignShare": totals.get("campaignShare", 0),
        "flowShare": totals.get("flowShare", 0),
    }


def _site_totals_snapshot(row: dict) -> dict[str, Any]:
    total = row["totalGmvCny"] or 1
    c = row["campaign"]
    f = row["flow"]
    return {
        "gmvLocal": c["gmv"] + f["gmv"],
        "gmvCny": row["totalGmvCny"],
        "campaignShare": row["campaignGmvCny"] / total,
        "flowShare": row["flowGmvCny"] / total,
    }


def _site_channel_snapshot(row: dict, channel: str) -> dict[str, Any]:
    block = row[channel]
    gmv_key = "campaignGmvCny" if channel == "campaign" else "flowGmvCny"
    return {
        "gmvLocal": block["gmv"],
        "gmvCny": row[gmv_key],
        "openRate": block["openRate"],
        "clickRate": block["clickRate"],
        "convRate": block["convRate"],
    }


def _compare_metric(
    key: str,
    label: str,
    current: float,
    mom: float | None,
    yoy: float | None,
    *,
    kind: str = "number",
    higher_is_better: bool = True,
) -> dict[str, Any]:
    mom_pct = _pct_change(current, mom) if mom is not None else None
    yoy_pct = _pct_change(current, yoy) if yoy is not None else None
    return {
        "key": key,
        "label": label,
        "kind": kind,
        "higherIsBetter": higher_is_better,
        "current": current,
        "mom": {
            "value": mom,
            "delta": _delta(current, mom) if mom is not None else None,
            "pct": mom_pct,
            "pctLabel": _fmt_pct(mom_pct),
        },
        "yoy": {
            "value": yoy,
            "delta": _delta(current, yoy) if yoy is not None else None,
            "pct": yoy_pct,
            "pctLabel": _fmt_pct(yoy_pct),
        },
    }


GLOBAL_TOTALS_METRICS: list[tuple[str, str, str, bool]] = [
    ("gmvCny", "合计 GMV (CNY)", "cny", True),
    ("campaignCny", "Campaign GMV (CNY)", "cny", True),
    ("flowCny", "Flow GMV (CNY)", "cny", True),
    ("campaignShare", "Campaign 占比", "rate", True),
    ("flowShare", "Flow 占比", "rate", True),
]

GLOBAL_CHANNEL_METRICS: list[tuple[str, str, str, bool]] = [
    ("gmvCny", "GMV (CNY)", "cny", True),
    ("openRate", "打开率", "rate", True),
    ("clickRate", "点击率", "rate", True),
    ("convRate", "转化率", "rate", True),
]

SITE_TOTALS_METRICS: list[tuple[str, str, str, bool]] = [
    ("gmvLocal", "合计 GMV (本位币)", "local", True),
    ("gmvCny", "合计 GMV (CNY)", "cny", True),
    ("campaignShare", "Campaign 占比", "rate", True),
    ("flowShare", "Flow 占比", "rate", True),
]

SITE_CHANNEL_METRICS: list[tuple[str, str, str, bool]] = [
    ("gmvLocal", "GMV (本位币)", "local", True),
    ("gmvCny", "GMV (CNY)", "cny", True),
    ("openRate", "打开率", "rate", True),
    ("clickRate", "点击率", "rate", True),
    ("convRate", "转化率", "rate", True),
]


def _prefix_labels(
    metric_defs: list[tuple[str, str, str, bool]],
    prefix: str,
) -> list[tuple[str, str, str, bool]]:
    return [(k, f"{prefix} {label}" if not label.startswith(prefix) else label, kind, hb) for k, label, kind, hb in metric_defs]


def _build_scope_metrics(
    current: dict[str, Any],
    mom: dict[str, Any] | None,
    yoy: dict[str, Any] | None,
    metric_defs: list[tuple[str, str, str, bool]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key, label, kind, higher in metric_defs:
        out.append(
            _compare_metric(
                key,
                label,
                float(current.get(key, 0) or 0),
                float(mom[key]) if mom and mom.get(key) is not None else None,
                float(yoy[key]) if yoy and yoy.get(key) is not None else None,
                kind=kind,
                higher_is_better=higher,
            )
        )
    return out


def _build_group(
    cur: dict[str, Any],
    mom: dict[str, Any] | None,
    yoy: dict[str, Any] | None,
    metric_defs: list[tuple[str, str, str, bool]],
) -> dict[str, Any]:
    return {"metrics": _build_scope_metrics(cur, mom, yoy, metric_defs)}


def build_comparisons(
    current_totals: dict,
    mom_totals: dict | None,
    yoy_totals: dict | None,
    sites_current: list[dict],
    sites_mom: list[dict] | None,
    sites_yoy: list[dict] | None,
    *,
    period_meta: dict | None = None,
    mom_period: dict | None = None,
    yoy_period: dict | None = None,
) -> dict[str, Any]:
    """Return comparisons block with global + per-site MoM/YoY metrics (Campaign / Flow split)."""
    cur_totals = _totals_snapshot(current_totals)
    mom_totals_snap = _totals_snapshot(mom_totals) if mom_totals else None
    yoy_totals_snap = _totals_snapshot(yoy_totals) if yoy_totals else None

    cur_camp = _aggregate_channel(sites_current, "campaign")
    cur_flow = _aggregate_channel(sites_current, "flow")
    mom_camp = _aggregate_channel(sites_mom, "campaign") if sites_mom else None
    mom_flow = _aggregate_channel(sites_mom, "flow") if sites_mom else None
    yoy_camp = _aggregate_channel(sites_yoy, "campaign") if sites_yoy else None
    yoy_flow = _aggregate_channel(sites_yoy, "flow") if sites_yoy else None

    camp_defs = _prefix_labels(GLOBAL_CHANNEL_METRICS, "Campaign")
    flow_defs = _prefix_labels(GLOBAL_CHANNEL_METRICS, "Flow")
    site_camp_defs = _prefix_labels(SITE_CHANNEL_METRICS, "Campaign")
    site_flow_defs = _prefix_labels(SITE_CHANNEL_METRICS, "Flow")

    mom_by_site = {r["region"]: r for r in (sites_mom or [])}
    yoy_by_site = {r["region"]: r for r in (sites_yoy or [])}

    sites_out: dict[str, Any] = {}
    for row in sites_current:
        code = row["region"]
        mom_row = mom_by_site.get(code)
        yoy_row = yoy_by_site.get(code)
        sites_out[code] = {
            "currency": row["currency"],
            "totals": _build_group(
                _site_totals_snapshot(row),
                _site_totals_snapshot(mom_row) if mom_row else None,
                _site_totals_snapshot(yoy_row) if yoy_row else None,
                SITE_TOTALS_METRICS,
            ),
            "campaign": _build_group(
                _site_channel_snapshot(row, "campaign"),
                _site_channel_snapshot(mom_row, "campaign") if mom_row else None,
                _site_channel_snapshot(yoy_row, "campaign") if yoy_row else None,
                site_camp_defs,
            ),
            "flow": _build_group(
                _site_channel_snapshot(row, "flow"),
                _site_channel_snapshot(mom_row, "flow") if mom_row else None,
                _site_channel_snapshot(yoy_row, "flow") if yoy_row else None,
                site_flow_defs,
            ),
        }

    return {
        "meta": {
            "current": period_meta,
            "mom": mom_period,
            "yoy": yoy_period,
        },
        "global": {
            "totals": _build_group(cur_totals, mom_totals_snap, yoy_totals_snap, GLOBAL_TOTALS_METRICS),
            "campaign": _build_group(cur_camp, mom_camp, yoy_camp, camp_defs),
            "flow": _build_group(cur_flow, mom_flow, yoy_flow, flow_defs),
        },
        "sites": sites_out,
    }


def seed_comparison_snapshots(
    rows: list[dict],
    totals: dict,
    *,
    mom_factors: dict[str, float] | None = None,
    yoy_factors: dict[str, float] | None = None,
) -> tuple[dict, list[dict], dict, list[dict]]:
    """Derive plausible MoM/YoY snapshots from current seed data."""
    mom_factors = mom_factors or {
        "gmv": 0.92,
        "campaignGmv": 0.9,
        "flowGmv": 0.94,
        "openRate": 0.98,
        "clickRate": 0.97,
        "convRate": 0.95,
    }
    yoy_factors = yoy_factors or {
        "gmv": 0.85,
        "campaignGmv": 0.82,
        "flowGmv": 0.88,
        "openRate": 0.96,
        "clickRate": 0.94,
        "convRate": 0.9,
    }

    def scale_row(row: dict, factors: dict[str, float]) -> dict:
        c = dict(row["campaign"])
        f = dict(row["flow"])
        c["gmv"] = round(c["gmv"] * factors.get("campaignGmv", factors["gmv"]), 2)
        f["gmv"] = round(f["gmv"] * factors.get("flowGmv", factors["gmv"]), 2)
        c["conversions"] = max(0, int(c["conversions"] * factors.get("convRate", 1)))
        f["conversions"] = max(0, int(f["conversions"] * factors.get("convRate", 1)))
        c["openRate"] = c["openRate"] * factors.get("openRate", 1)
        f["openRate"] = f["openRate"] * factors.get("openRate", 1)
        c["clickRate"] = c["clickRate"] * factors.get("clickRate", 1)
        f["clickRate"] = f["clickRate"] * factors.get("clickRate", 1)
        camp_cny = round(row["campaignGmvCny"] * factors.get("campaignGmv", factors["gmv"]), 0)
        flow_cny = round(row["flowGmvCny"] * factors.get("flowGmv", factors["gmv"]), 0)
        return {
            **row,
            "campaign": c,
            "flow": f,
            "campaignGmvCny": camp_cny,
            "flowGmvCny": flow_cny,
            "totalGmvCny": camp_cny + flow_cny,
        }

    mom_rows = [scale_row(r, mom_factors) for r in rows]
    yoy_rows = [scale_row(r, yoy_factors) for r in rows]

    def totals_from_scaled(scaled_rows: list[dict]) -> dict:
        total_campaign = sum(r["campaignGmvCny"] for r in scaled_rows)
        total_flow = sum(r["flowGmvCny"] for r in scaled_rows)
        total_gmv = total_campaign + total_flow
        delivered = sum(r["campaign"]["delivered"] + r["flow"]["delivered"] for r in scaled_rows)
        open_w = sum(
            r["campaign"]["openRate"] * r["campaign"]["delivered"]
            + r["flow"]["openRate"] * r["flow"]["delivered"]
            for r in scaled_rows
        )
        click_w = sum(
            r["campaign"]["clickRate"] * r["campaign"]["delivered"]
            + r["flow"]["clickRate"] * r["flow"]["delivered"]
            for r in scaled_rows
        )
        conv = sum(r["campaign"]["conversions"] + r["flow"]["conversions"] for r in scaled_rows)
        d = delivered or 1
        return {
            "campaignCny": total_campaign,
            "flowCny": total_flow,
            "gmvCny": total_gmv,
            "campaignShare": total_campaign / total_gmv if total_gmv else 0,
            "flowShare": total_flow / total_gmv if total_gmv else 0,
            "global": {
                "openRate": open_w / d,
                "clickRate": click_w / d,
                "convRate": conv / d,
                "gmvCny": total_gmv,
            },
        }

    return totals_from_scaled(mom_rows), mom_rows, totals_from_scaled(yoy_rows), yoy_rows
