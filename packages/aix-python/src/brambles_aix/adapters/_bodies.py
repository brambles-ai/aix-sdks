"""The request bodies the framework guides build, shared by both adapters. The session id, the
country, consent and privacy signals come from the server's context, never from the model."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..types import AixContext


def intent_body(ctx: AixContext | Mapping[str, Any], task: Mapping[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"session_id": ctx["session_id"], "task": dict(task)}
    if ctx.get("country"):
        body["country"] = ctx["country"]
    # Intents carry an opt-out; "granted" goes on the handoff that follows the notice.
    signals = {**(ctx.get("privacy") or {}), **({"consent": "denied"} if ctx.get("consent") == "denied" else {})}
    if signals:
        body["privacy"] = signals
    return body


def handoff_body(ctx: AixContext | Mapping[str, Any], destination_url: str) -> dict[str, Any]:
    body: dict[str, Any] = {"session_id": ctx["session_id"], "destination_url": destination_url}
    if ctx.get("consent"):
        body["consent"] = ctx["consent"]
    return body
