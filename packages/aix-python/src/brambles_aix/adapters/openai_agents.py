"""The two AIX operations as OpenAI Agents SDK function tools, following "Defined in code
(Python)" in the OpenAI Agents SDK guide.

    client = AixClient(os.environ.get("AIX_SENDER_KEY"))
    ctx = {"session_id": conversation_id, "country": country, "consent": consent, "privacy": privacy}
    agent = Agent(name="Shopping assistant", instructions=aix_rules(ctx), tools=aix_tools(client, ctx))

Build the tools for each conversation. ``ctx`` comes from your server, never from the model: the
conversation id, the shopper's two-letter country from your host's geolocation header (``None``
when unknown), consent, and privacy signals such as ``{"gpc": True}`` for a request carrying
``Sec-GPC: 1``. The model supplies only the task and the store's URL.

Requires the ``openai-agents`` extra. Every failure returns a ``skipped`` result; nothing raises.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping
from typing import Any, Literal

from agents import function_tool

from ..client import AixClient
from ..types import AixContext
from ._bodies import handoff_body, intent_body

if sys.version_info >= (3, 12):
    from typing import TypedDict
else:  # pydantic (used by function_tool) needs typing_extensions.TypedDict before 3.12
    from typing_extensions import TypedDict


class Budget(TypedDict):
    currency: str
    max_cents: int


class Fact(TypedDict):
    attribute: Literal["brand", "width", "size", "department", "use_case", "feature", "merchant", "deal"]
    value: str
    strength: Literal["required", "preferred", "excluded"]


class Task(TypedDict):
    category: str
    summary: str
    budget: Budget | None  # strict tool schemas require every field: null when the shopper named none
    facts: list[Fact]


class Intent(TypedDict):
    task: Task


def aix_tools(client: AixClient, ctx: AixContext | Mapping[str, Any]) -> list[Any]:
    """``[submit_intent, report_handoff]`` for one conversation; pass the list as ``Agent(tools=...)``."""

    @function_tool
    async def submit_intent(intent: Intent) -> dict:
        """Report the shopper's current shopping task to AIX. Call after any turn that states or changes
        what they want to buy, with intent: the task. Shopping requirements only, never personal data."""
        # A null budget is dropped: sent as null it would tell AIX the shopper removed their budget.
        task = {k: v for k, v in intent["task"].items() if v is not None}
        return dict(await client.asend_intent(intent_body(ctx, task)))

    @function_tool
    async def report_handoff(destination_url: str) -> dict:
        """Report that the shopper is being sent to a store or product page (the store's own URL).
        Use the returned landing_url as that page's URL, inside your affiliate link if you use one."""
        return dict(await client.areport_handoff(handoff_body(ctx, destination_url)))

    return [submit_intent, report_handoff]
