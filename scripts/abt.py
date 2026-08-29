"""Build Klaviyo A/B test (ABT) payload for the EDM dashboard.

Uses variation-grouped campaign/flow reports plus flow-action type AB_TEST
to classify 正在 ABT (running) vs 结束 ABT (completed).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from klaviyo_config import REGIONS, SITE_ORDER, RegionConfig, api_key_for, klaviyo_timeframe, period_meta

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "dashboard" / "data"
API_PREFIX = "https://a.klaviyo.com/api"

STATS = [
    "recipients",
    "delivered",
    "open_rate",
    "click_rate",
    "conversion_rate",
    "conversions",
    "conversion_value",
]


def _path_from_link(url: str) -> str:
    if not url:
        return url
    if url.startswith("http"):
        parsed = urlparse(url)
        path = parsed.path
        if path.startswith("/api"):
            path = path[4:]
        return f"{path}?{parsed.query}" if parsed.query else path
    return url


def _paginate_get(client, path: str) -> list[dict]:
    items: list[dict] = []
    next_url: str | None = path
    while next_url:
        payload = client._request("GET", _path_from_link(next_url))
        items.extend(payload.get("data") or [])
        nxt = (payload.get("links") or {}).get("next")
        if not nxt:
            break
        next_url = nxt
        time.sleep(0.12)
    return items


def _paginate_report(client, path: str, body: dict) -> list[dict]:
    results: list[dict] = []
    next_url: str | None = path
    pages = 0
    while next_url and pages < 8:
        payload = client._request("POST", _path_from_link(next_url), body)
        attrs = (payload.get("data") or {}).get("attributes") or {}
        results.extend(attrs.get("results") or [])
        nxt = (payload.get("links") or {}).get("next")
        if not nxt:
            break
        next_url = nxt
        pages += 1
        time.sleep(0.2)
    return results


def _metrics(stats: dict) -> dict:
    delivered = float(stats.get("delivered") or 0)
    recipients = float(stats.get("recipients") or 0)
    return {
        "recipients": int(recipients),
        "delivered": int(delivered),
        "openRate": float(stats.get("open_rate") or 0),
        "clickRate": float(stats.get("click_rate") or 0),
        "convRate": float(stats.get("conversion_rate") or 0),
        "conversions": int(float(stats.get("conversions") or 0)),
        "gmv": round(float(stats.get("conversion_value") or 0), 2),
    }


def _short_variation_label(name: str, fallback: str = "") -> str:
    raw = (name or "").strip()
    if not raw:
        return fallback or "变体"
    lower = raw.lower()
    for letter in ("a", "b", "c", "d"):
        if f"variation {letter}" in lower:
            return f"Variation {letter.upper()}"
    if lower.endswith(" a"):
        return "Variation A"
    if lower.endswith(" b"):
        return "Variation B"
    if len(raw) > 48:
        return raw[:45] + "…"
    return raw


def _common_test_name(names: list[str], fallback: str) -> str:
    cleaned = [n.strip() for n in names if n and n.strip()]
    if not cleaned:
        return fallback
    if len(cleaned) == 1:
        return cleaned[0]
    prefix = cleaned[0]
    for name in cleaned[1:]:
        i = 0
        limit = min(len(prefix), len(name))
        while i < limit and prefix[i] == name[i]:
            i += 1
        prefix = prefix[:i]
    prefix = prefix.rsplit("Variation", 1)[0].strip(" -_#")
    return prefix or fallback


def _campaign_status(status: str, send_method: str) -> str:
    s = (status or "").strip().lower()
    if s in {"sent", "cancelled", "canceled"}:
        return "completed"
    if send_method == "ab_test_campaign" and s in {"draft", "scheduled", "sending", "queued", "variations sending"}:
        return "running"
    if s in {"draft", "scheduled", "sending", "queued"}:
        return "running"
    return "completed"


def _pick_leader(variations: list[dict], *, completed: bool) -> dict | None:
    if not variations:
        return None
    if completed:
        scored = sorted(variations, key=lambda v: (v.get("recipients") or 0, v.get("openRate") or 0), reverse=True)
        top = scored[0]
        total = sum(v.get("recipients") or 0 for v in variations) or 1
        if (top.get("recipients") or 0) / total >= 0.55:
            return top
        scored = sorted(variations, key=lambda v: (v.get("openRate") or 0, v.get("clickRate") or 0), reverse=True)
        return scored[0]
    scored = sorted(variations, key=lambda v: (v.get("openRate") or 0, v.get("clickRate") or 0, v.get("recipients") or 0), reverse=True)
    return scored[0]


def _lift(winner: dict | None, variations: list[dict], key: str = "openRate") -> float | None:
    if not winner or len(variations) < 2:
        return None
    others = [v for v in variations if v.get("id") != winner.get("id")]
    if not others:
        return None
    best_other = max(float(v.get(key) or 0) for v in others)
    if best_other <= 0:
        return None
    return (float(winner.get(key) or 0) - best_other) / best_other


def fetch_region_abt(region: RegionConfig, client) -> tuple[list[dict], str | None]:
    metric_id = region.metric_id
    if not metric_id:
        try:
            metric_id = client.resolve_placed_order_metric()
        except Exception as e:
            return [], f"{region.code}: {e}"

    camp_body = {
        "data": {
            "type": "campaign-values-report",
            "attributes": {
                "timeframe": client.timeframe,
                "conversion_metric_id": metric_id,
                "filter": 'equals(send_channel,"email")',
                "statistics": STATS,
                "group_by": ["campaign_id", "campaign_message_id", "variation", "variation_name"],
            },
        }
    }
    flow_body = {
        "data": {
            "type": "flow-values-report",
            "attributes": {
                "timeframe": client.timeframe,
                "conversion_metric_id": metric_id,
                "filter": 'equals(send_channel,"email")',
                "statistics": STATS,
                "group_by": ["flow_id", "flow_message_id", "variation", "variation_name"],
            },
        }
    }

    try:
        camp_rows = _paginate_report(client, "/campaign-values-reports/", camp_body)
        time.sleep(0.35)
        flow_rows = _paginate_report(client, "/flow-values-reports/", flow_body)
    except Exception as e:
        return [], f"{region.code}: report {e}"

    tests: list[dict] = []
    tests.extend(_build_campaign_tests(region, client, camp_rows))
    tests.extend(_build_flow_tests(region, client, flow_rows))
    return tests, None


def _build_campaign_tests(region: RegionConfig, client, rows: list[dict]) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        g = row.get("groupings") or {}
        cid = g.get("campaign_id") or ""
        var = g.get("variation") or g.get("variation_name")
        if not cid or not var:
            continue
        grouped[cid].append(row)

    out: list[dict] = []
    for cid, var_rows in grouped.items():
        names = [(r.get("groupings") or {}).get("variation_name") or "" for r in var_rows]
        info = {"name": cid, "status": "Sent", "send_strategy": {}}
        messages: list[dict] = []
        try:
            payload = client._request("GET", f"/campaigns/{cid}")
            attrs = (payload.get("data") or {}).get("attributes") or {}
            info["name"] = attrs.get("name") or cid
            info["status"] = attrs.get("status") or "Sent"
            info["send_strategy"] = attrs.get("send_strategy") or {}
            time.sleep(0.12)
            msg_payload = client._request("GET", f"/campaigns/{cid}/campaign-messages/")
            messages = msg_payload.get("data") or []
        except Exception:
            pass
        if len(var_rows) < 2 and (info.get("send_strategy") or {}).get("method") != "ab_test_campaign":
            continue
        send_method = (info.get("send_strategy") or {}).get("method") or ""
        status = _campaign_status(info.get("status") or "", send_method)
        msg_by_id = {m.get("id"): m for m in messages}
        variations = []
        for row in var_rows:
            g = row.get("groupings") or {}
            vid = g.get("variation") or g.get("campaign_message_id") or ""
            vname = g.get("variation_name") or vid
            msg = msg_by_id.get(vid) or {}
            content = (msg.get("attributes") or {}).get("content") or {}
            m = _metrics(row.get("statistics") or {})
            variations.append(
                {
                    "id": vid,
                    "name": _short_variation_label(vname, vid),
                    "fullName": vname,
                    "subject": content.get("subject") or "",
                    **m,
                    "gmvCny": round(m["gmv"] * region.fx_to_cny, 0),
                }
            )
        variations.sort(key=lambda v: v.get("name") or "")
        test_name = _common_test_name(names, info["name"])
        completed = status == "completed"
        leader = _pick_leader(variations, completed=completed)
        for v in variations:
            v["isWinner"] = bool(leader and v.get("id") == leader.get("id") and completed)
            v["isLeader"] = bool(leader and v.get("id") == leader.get("id"))
        delivered = sum(v.get("delivered") or 0 for v in variations)
        open_w = sum((v.get("openRate") or 0) * (v.get("delivered") or 0) for v in variations)
        click_w = sum((v.get("clickRate") or 0) * (v.get("delivered") or 0) for v in variations)
        conv = sum(v.get("conversions") or 0 for v in variations)
        gmv = sum(v.get("gmv") or 0 for v in variations)
        d = delivered or 1
        out.append(
            {
                "id": f"{region.code}::campaign::{cid}",
                "region": region.code,
                "channel": "campaign",
                "status": status,
                "name": info["name"],
                "testName": test_name,
                "subject": next((v.get("subject") for v in variations if v.get("subject")), ""),
                "entityId": cid,
                "entityStatus": info.get("status") or "",
                "startedAt": None,
                "currency": region.currency,
                "winnerLabel": (leader or {}).get("name") if leader else None,
                "openLift": _lift(leader, variations, "openRate"),
                "clickLift": _lift(leader, variations, "clickRate"),
                "metrics": {
                    "recipients": sum(v.get("recipients") or 0 for v in variations),
                    "delivered": delivered,
                    "openRate": open_w / d,
                    "clickRate": click_w / d,
                    "convRate": conv / d,
                    "conversions": conv,
                    "gmv": round(gmv, 2),
                    "gmvCny": round(gmv * region.fx_to_cny, 0),
                },
                "variations": variations,
            }
        )
    return out


def _list_live_ab_actions(client) -> dict[str, list[dict]]:
    """flow_id -> list of AB_TEST actions with messages."""
    by_flow: dict[str, list[dict]] = {}
    try:
        flows = _paginate_get(client, "/flows/?filter=equals(status,'live')&fields[flow]=name,status&page[size]=50")
    except Exception:
        return by_flow
    for flow in flows:
        fid = flow.get("id")
        if not fid:
            continue
        fname = (flow.get("attributes") or {}).get("name") or fid
        try:
            time.sleep(0.12)
            actions = client._request("GET", f"/flows/{fid}/flow-actions/")
        except Exception:
            continue
        ab_actions = []
        for row in actions.get("data") or []:
            attrs = row.get("attributes") or {}
            if attrs.get("action_type") != "AB_TEST":
                continue
            aid = row.get("id")
            msgs: list[dict] = []
            if aid:
                try:
                    time.sleep(0.1)
                    mp = client._request("GET", f"/flow-actions/{aid}/flow-messages/")
                    for m in mp.get("data") or []:
                        mattr = m.get("attributes") or {}
                        content = mattr.get("content") or {}
                        msgs.append(
                            {
                                "id": m.get("id"),
                                "name": mattr.get("name") or "",
                                "subject": content.get("subject") or "",
                            }
                        )
                except Exception:
                    pass
            ab_actions.append(
                {
                    "id": aid,
                    "status": attrs.get("status") or "",
                    "created": attrs.get("created"),
                    "updated": attrs.get("updated"),
                    "flowName": fname,
                    "messages": msgs,
                }
            )
        if ab_actions:
            by_flow[fid] = ab_actions
    return by_flow


def _build_flow_tests(region: RegionConfig, client, rows: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        g = row.get("groupings") or {}
        fid = g.get("flow_id") or ""
        mid = g.get("flow_message_id") or ""
        var = g.get("variation") or g.get("variation_name")
        if not fid or not var:
            continue
        grouped[(fid, mid)].append(row)

    ab_by_flow = _list_live_ab_actions(client)
    flow_names: dict[str, str] = {}
    for fid, actions in ab_by_flow.items():
        if actions:
            flow_names[fid] = actions[0].get("flowName") or fid

    used_action_ids: set[str] = set()
    out: list[dict] = []

    def flow_name(fid: str) -> str:
        if fid in flow_names:
            return flow_names[fid]
        try:
            payload = client._request("GET", f"/flows/{fid}")
            name = ((payload.get("data") or {}).get("attributes") or {}).get("name") or fid
            flow_names[fid] = name
            time.sleep(0.1)
            return name
        except Exception:
            return fid

    def match_action(fid: str, var_rows: list[dict]) -> dict | None:
        ids = set()
        for row in var_rows:
            g = row.get("groupings") or {}
            if g.get("flow_message_id"):
                ids.add(g["flow_message_id"])
            if g.get("variation"):
                ids.add(g["variation"])
        for action in ab_by_flow.get(fid) or []:
            msg_ids = {m.get("id") for m in action.get("messages") or [] if m.get("id")}
            if msg_ids & ids:
                return action
        live = [a for a in (ab_by_flow.get(fid) or []) if (a.get("status") or "").lower() == "live" and a.get("id") not in used_action_ids]
        return live[0] if live else None

    for (fid, mid), var_rows in grouped.items():
        if len(var_rows) < 2:
            continue
        action = match_action(fid, var_rows)
        action_status = (action.get("status") if action else "") or ""
        if (action_status or "").lower() == "live":
            status = "running"
        else:
            status = "completed"
        if action and action.get("id"):
            used_action_ids.add(action["id"])
        msg_meta = {m.get("id"): m for m in (action.get("messages") if action else []) or []}
        variations = []
        names = []
        for row in var_rows:
            g = row.get("groupings") or {}
            vid = g.get("variation") or ""
            vname = g.get("variation_name") or vid
            names.append(vname)
            meta = msg_meta.get(vid) or {}
            m = _metrics(row.get("statistics") or {})
            variations.append(
                {
                    "id": vid,
                    "name": _short_variation_label(vname, vid),
                    "fullName": vname,
                    "subject": meta.get("subject") or "",
                    **m,
                    "gmvCny": round(m["gmv"] * region.fx_to_cny, 0),
                }
            )
        variations.sort(key=lambda v: v.get("name") or "")
        fname = (action or {}).get("flowName") or flow_name(fid)
        test_name = _common_test_name(names, fname)
        completed = status == "completed"
        leader = _pick_leader(variations, completed=completed)
        for v in variations:
            v["isWinner"] = bool(leader and v.get("id") == leader.get("id") and completed)
            v["isLeader"] = bool(leader and v.get("id") == leader.get("id"))
        delivered = sum(v.get("delivered") or 0 for v in variations)
        open_w = sum((v.get("openRate") or 0) * (v.get("delivered") or 0) for v in variations)
        click_w = sum((v.get("clickRate") or 0) * (v.get("delivered") or 0) for v in variations)
        conv = sum(v.get("conversions") or 0 for v in variations)
        gmv = sum(v.get("gmv") or 0 for v in variations)
        d = delivered or 1
        out.append(
            {
                "id": f"{region.code}::flow::{fid}::{mid}",
                "region": region.code,
                "channel": "flow",
                "status": status,
                "name": fname,
                "testName": test_name,
                "subject": next((v.get("subject") for v in variations if v.get("subject")), ""),
                "entityId": fid,
                "entityStatus": action_status,
                "startedAt": action.get("created") if action else None,
                "currency": region.currency,
                "winnerLabel": (leader or {}).get("name") if leader else None,
                "openLift": _lift(leader, variations, "openRate"),
                "clickLift": _lift(leader, variations, "clickRate"),
                "metrics": {
                    "recipients": sum(v.get("recipients") or 0 for v in variations),
                    "delivered": delivered,
                    "openRate": open_w / d,
                    "clickRate": click_w / d,
                    "convRate": conv / d,
                    "conversions": conv,
                    "gmv": round(gmv, 2),
                    "gmvCny": round(gmv * region.fx_to_cny, 0),
                },
                "variations": variations,
            }
        )

    # Live AB_TEST with no variation report rows (just started).
    reported_flow_ids = {fid for fid, _mid in grouped}
    for fid, actions in ab_by_flow.items():
        for action in actions:
            if (action.get("status") or "").lower() != "live":
                continue
            if action.get("id") in used_action_ids:
                continue
            msgs = action.get("messages") or []
            if len(msgs) < 2 and fid in reported_flow_ids:
                continue
            variations = []
            for msg in msgs:
                variations.append(
                    {
                        "id": msg.get("id") or "",
                        "name": _short_variation_label(msg.get("name") or "", msg.get("id") or "变体"),
                        "fullName": msg.get("name") or "",
                        "subject": msg.get("subject") or "",
                        "recipients": 0,
                        "delivered": 0,
                        "openRate": 0,
                        "clickRate": 0,
                        "convRate": 0,
                        "conversions": 0,
                        "gmv": 0,
                        "gmvCny": 0,
                        "isWinner": False,
                        "isLeader": False,
                    }
                )
            if not variations:
                variations = [
                    {
                        "id": "a",
                        "name": "Variation A",
                        "fullName": "",
                        "subject": "",
                        "recipients": 0,
                        "delivered": 0,
                        "openRate": 0,
                        "clickRate": 0,
                        "convRate": 0,
                        "conversions": 0,
                        "gmv": 0,
                        "gmvCny": 0,
                        "isWinner": False,
                        "isLeader": False,
                    },
                    {
                        "id": "b",
                        "name": "Variation B",
                        "fullName": "",
                        "subject": "",
                        "recipients": 0,
                        "delivered": 0,
                        "openRate": 0,
                        "clickRate": 0,
                        "convRate": 0,
                        "conversions": 0,
                        "gmv": 0,
                        "gmvCny": 0,
                        "isWinner": False,
                        "isLeader": False,
                    },
                ]
            fname = action.get("flowName") or flow_name(fid)
            names = [m.get("name") or "" for m in msgs]
            out.append(
                {
                    "id": f"{region.code}::flow::{fid}::action::{action.get('id')}",
                    "region": region.code,
                    "channel": "flow",
                    "status": "running",
                    "name": fname,
                    "testName": _common_test_name(names, fname),
                    "subject": next((m.get("subject") for m in msgs if m.get("subject")), ""),
                    "entityId": fid,
                    "entityStatus": "live",
                    "startedAt": action.get("created"),
                    "currency": region.currency,
                    "winnerLabel": None,
                    "openLift": None,
                    "clickLift": None,
                    "metrics": {
                        "recipients": 0,
                        "delivered": 0,
                        "openRate": 0,
                        "clickRate": 0,
                        "convRate": 0,
                        "conversions": 0,
                        "gmv": 0,
                        "gmvCny": 0,
                    },
                    "variations": variations,
                }
            )
    return out


def _summarize(tests: list[dict]) -> dict:
    running = sum(1 for t in tests if t.get("status") == "running")
    completed = sum(1 for t in tests if t.get("status") == "completed")
    return {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "testCount": len(tests),
        "runningCount": running,
        "completedCount": completed,
        "campaignCount": sum(1 for t in tests if t.get("channel") == "campaign"),
        "flowCount": sum(1 for t in tests if t.get("channel") == "flow"),
    }


def _ensure_api_keys() -> None:
    if any(api_key_for(r) for r in REGIONS):
        return
    try:
        from _load_mcp_keys import load_mcp_keys

        load_mcp_keys()
    except Exception:
        pass


def attach_abt(dashboard: dict, timeframe: dict, *, regions: list[RegionConfig] | None = None) -> dict:
    """Fetch ABT for all keyed regions and attach to dashboard JSON."""
    from sync_dashboard import API_THROTTLE_SEC, KlaviyoClient, SITE_WORKERS

    _ensure_api_keys()

    tests: list[dict] = []
    errors: list[str] = []
    target = regions if regions is not None else [r for r in REGIONS if api_key_for(r)]
    target = [r for r in target if api_key_for(r)]

    def _one(region: RegionConfig) -> tuple[list[dict], str | None]:
        try:
            client = KlaviyoClient(api_key_for(region), timeframe)
            time.sleep(API_THROTTLE_SEC)
            rows, err = fetch_region_abt(region, client)
            print(f"OK {region.code} ABT ({len(rows)} tests)", file=sys.stderr)
            return rows, err
        except Exception as e:
            msg = f"{region.code} ABT: {e}"
            print(f"SKIP {msg}", file=sys.stderr)
            return [], msg

    with ThreadPoolExecutor(max_workers=SITE_WORKERS) as pool:
        futures = {pool.submit(_one, r): r for r in target}
        for fut in as_completed(futures):
            rows, err = fut.result()
            tests.extend(rows)
            if err:
                errors.append(err)

    tests.sort(
        key=lambda t: (
            0 if t.get("status") == "running" else 1,
            SITE_ORDER.index(t["region"]) if t.get("region") in SITE_ORDER else 99,
            -(t.get("metrics") or {}).get("delivered") or 0,
        )
    )
    dashboard["abt"] = {"meta": _summarize(tests), "tests": tests}
    if errors:
        dashboard["meta"].setdefault("errors", [])
        dashboard["meta"]["errors"].extend(errors)
    return dashboard


def patch_dashboard_files(abt: dict, files: list[Path]) -> None:
    for path in files:
        if not path.exists():
            print(f"skip missing {path}", file=sys.stderr)
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        data["abt"] = abt
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Patched {path} ({abt.get('meta', {}).get('testCount', 0)} ABT)")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Fetch Klaviyo ABT and patch dashboard JSON.")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--region", action="append", help="Limit to region code (repeatable)")
    p.add_argument("--patch", action="store_true", help="Write abt into existing dashboard JSON files")
    args = p.parse_args(argv)

    if args.start and args.end:
        timeframe = klaviyo_timeframe(start=args.start, end=args.end)
        period = period_meta(start=args.start, end=args.end)
        files = [DATA_DIR / f"dashboard-custom-{args.start}_{args.end}.json"]
    else:
        timeframe = klaviyo_timeframe(days=args.days)
        period = period_meta(days=args.days)
        files = [DATA_DIR / f"dashboard-{args.days}d.json"]
        if args.days == 30:
            files.append(DATA_DIR / "dashboard.json")

    wanted = None
    if args.region:
        codes = {c.upper() for c in args.region}
        wanted = [r for r in REGIONS if r.code in codes]

    dummy = {"meta": {"errors": []}, "abt": {}}
    attach_abt(dummy, timeframe, regions=wanted)
    dummy["abt"]["meta"]["period"] = period
    if args.patch:
        patch_dashboard_files(dummy["abt"], files)
    else:
        out = DATA_DIR / "abt-preview.json"
        out.write_text(json.dumps(dummy["abt"], ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
