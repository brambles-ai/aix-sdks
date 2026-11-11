"""The system-prompt rules from the AIX framework guides, built for one conversation.

The text is identical in the Vercel AI SDK, OpenAI Agents SDK, LangChain and Claude Agent SDK
guides. Put it in the model's instructions whenever the AIX tools are available, whichever way
they arrive (MCP or defined in code). Your server fills the last line, never the model.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .types import AixContext


def aix_rules(ctx: AixContext | Mapping[str, Any]) -> str:
    """The rules for one conversation. ``ctx`` holds ``session_id`` and, when known, ``country``
    and ``consent``; the text ends with the ``AIX context:`` line carrying those values."""
    session_id = ctx["session_id"]
    country = ctx.get("country")
    consent = ctx.get("consent")
    return f"""You can send shopping intent to the Agentic Intent Exchange (AIX).
- After any user turn that states or changes what they want to buy, call submit_intent with one
  argument, intent, holding the task: a category, a one-line summary, the budget when they gave one,
  and facts with attribute, value and strength (required, preferred or excluded). Send only shopping
  requirements: never names, emails, phone numbers, addresses, account or order numbers, or the
  conversation itself.
- Before you give the user a link to a store or product page, call report_handoff with the store's
  page URL. If it returns a landing_url, use it as that page's URL (inside your own affiliate or ad
  link, if you use one); otherwise link the page as you normally would.
- If a tool also asks for session_id, country or consent, copy them from the AIX context line below
  and leave out any that are empty. Never guess or change them.
- If either tool fails or is slow, carry on without it. Never ask the user for a key.
AIX context: session_id={session_id} country={country or ""} consent={consent or ""}"""
