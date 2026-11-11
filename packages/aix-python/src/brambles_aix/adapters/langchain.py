"""The two AIX operations as LangChain tools, following "Defined in code" in the LangChain guide.

    client = AixClient(os.environ.get("AIX_SENDER_KEY"))
    ctx = {"session_id": conversation_id, "country": country, "consent": consent, "privacy": privacy}
    agent = create_agent(model, aix_tools(client, ctx), system_prompt=aix_rules(ctx))

Build the tools for each conversation. ``ctx`` comes from your server, never from the model: the
conversation id, the shopper's two-letter country from your host's geolocation header (``None``
when unknown), consent, and privacy signals such as ``{"gpc": True}`` for a request carrying
``Sec-GPC: 1``. The model supplies only the task and the store's URL.

Requires the ``langchain`` extra (``langchain-core`` and ``pydantic``). The tools are async,
as in the guide; every failure returns a ``skipped`` result and nothing raises.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from ..client import AixClient
from ..types import AixContext
from ._bodies import handoff_body, intent_body


class Budget(BaseModel):
    currency: str = Field(min_length=3, max_length=3)
    max_cents: int


class Fact(BaseModel):
    attribute: Literal["brand", "width", "size", "department", "use_case", "feature", "merchant", "deal"]
    value: str
    strength: Literal["required", "preferred", "excluded"]


class Task(BaseModel):
    category: str
    summary: str = Field(max_length=1600)
    budget: Budget | None = None
    facts: list[Fact] = []


class Intent(BaseModel):
    task: Task


def aix_tools(client: AixClient, ctx: AixContext | Mapping[str, Any]) -> list[Any]:
    """``[submit_intent, report_handoff]`` for one conversation; pass the list to ``create_agent``."""

    @tool
    async def submit_intent(intent: Intent) -> dict:
        """Report the shopper's current shopping task to AIX. Call after any turn that states or changes
        what they want to buy, with intent: the task. Shopping requirements only, never personal data."""
        return dict(await client.asend_intent(intent_body(ctx, intent.task.model_dump(exclude_none=True))))

    @tool
    async def report_handoff(destination_url: str) -> dict:
        """Report that the shopper is being sent to a store or product page (the store's own URL).
        Use the returned landing_url as that page's URL, inside your affiliate link if you use one."""
        return dict(await client.areport_handoff(handoff_body(ctx, destination_url)))

    return [submit_intent, report_handoff]
