"""Resolve Klaviyo campaign/flow/list names from IDs (report rows only include groupings)."""

from __future__ import annotations

import time
import urllib.request


class EntityCache:
    def __init__(self, client: "KlaviyoClient"):
        self.client = client
        self.campaigns: dict[str, dict] = {}
        self.flows: dict[str, dict] = {}
        self.flow_messages: dict[str, dict] = {}
        self.flow_message_order: dict[str, dict[str, int]] = {}
        self.audiences: dict[str, str] = {}

    def campaign_info(self, campaign_id: str) -> dict:
        if campaign_id in self.campaigns:
            return self.campaigns[campaign_id]
        info = {"name": campaign_id, "subject": "", "status": "Sent", "audiences": []}
        try:
            payload = self.client._request("GET", f"/campaigns/{campaign_id}")
            attrs = payload.get("data", {}).get("attributes") or {}
            info["name"] = attrs.get("name") or campaign_id
            info["status"] = attrs.get("status") or "Sent"
            aud = attrs.get("audiences") or {}
            included = aud.get("included") or []
            info["audiences"] = [self.audience_name(aid) for aid in included[:4]]
            time.sleep(0.15)
            msgs = self.client._request("GET", f"/campaigns/{campaign_id}/campaign-messages/")
            for msg in msgs.get("data") or []:
                content = (msg.get("attributes") or {}).get("content") or {}
                if content.get("subject"):
                    info["subject"] = content["subject"]
                    break
        except RuntimeError:
            pass
        self.campaigns[campaign_id] = info
        return info

    def flow_info(self, flow_id: str) -> dict:
        if flow_id in self.flows:
            return self.flows[flow_id]
        info = {"name": flow_id, "status": "live"}
        try:
            payload = self.client._request("GET", f"/flows/{flow_id}")
            attrs = payload.get("data", {}).get("attributes") or {}
            info["name"] = attrs.get("name") or flow_id
            info["status"] = attrs.get("status") or "live"
        except RuntimeError:
            pass
        self.flows[flow_id] = info
        return info

    def flow_message_info(self, message_id: str) -> dict:
        if message_id in self.flow_messages:
            return self.flow_messages[message_id]
        info = {"name": message_id, "subject": "", "position": None}
        try:
            payload = self.client._request("GET", f"/flow-messages/{message_id}")
            attrs = payload.get("data", {}).get("attributes") or {}
            defn = attrs.get("definition") or {}
            content = attrs.get("content") or {}
            info["name"] = attrs.get("name") or defn.get("name") or message_id
            info["subject"] = (
                content.get("subject")
                or defn.get("subject_line")
                or attrs.get("name")
                or defn.get("name")
                or ""
            )
            time.sleep(0.15)
        except RuntimeError:
            pass
        self.flow_messages[message_id] = info
        return info

    def flow_message_positions(self, flow_id: str) -> dict[str, int]:
        """Email send order within a flow (1-based), when flow-actions API is available."""
        if flow_id in self.flow_message_order:
            return self.flow_message_order[flow_id]
        order: dict[str, int] = {}
        try:
            payload = self.client._request("GET", f"/flows/{flow_id}/flow-actions/")
            pos = 0
            for row in payload.get("data") or []:
                rel = (row.get("relationships") or {}).get("flow-messages") or {}
                msg_data = rel.get("data")
                ids: list[str] = []
                if isinstance(msg_data, list):
                    ids = [m.get("id") for m in msg_data if m.get("id")]
                elif isinstance(msg_data, dict) and msg_data.get("id"):
                    ids = [msg_data["id"]]
                for mid in ids:
                    pos += 1
                    order[mid] = pos
            time.sleep(0.15)
        except RuntimeError:
            pass
        self.flow_message_order[flow_id] = order
        return order

    def enrich_flow_message_meta(self, flow_id: str, message_ids: list[str]) -> None:
        """Resolve subject/name and send order for a bounded set of messages (rate-limit aware)."""
        positions = self.flow_message_positions(flow_id)
        for mid in message_ids:
            info = self.flow_message_info(mid)
            if mid in positions:
                info["position"] = positions[mid]

    def audience_name(self, audience_id: str) -> str:
        if audience_id in self.audiences:
            return self.audiences[audience_id]
        for path in (f"/lists/{audience_id}", f"/segments/{audience_id}"):
            try:
                payload = self.client._request("GET", path)
                name = (payload.get("data", {}).get("attributes") or {}).get("name")
                if name:
                    self.audiences[audience_id] = name
                    return name
            except RuntimeError:
                continue
        self.audiences[audience_id] = audience_id
        return audience_id
