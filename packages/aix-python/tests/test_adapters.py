import asyncio
import json

import pytest

from brambles_aix import AixClient, aix_rules
from support import SENDER_KEY, Recorder

TASK = {
    "category": "Running shoes",
    "summary": "Wide running shoes, cushioning preferred, up to $150.",
    "budget": {"currency": "USD", "max_cents": 15000},
    "facts": [{"attribute": "width", "value": "wide", "strength": "required"}],
}
STORE_URL = "https://store.example/p/1"
CTX = {"session_id": "conv_123", "country": "US", "consent": "granted", "privacy": {"gpc": True}}
ACCEPTED = {
    "status": "accepted", "intent_id": "aixint_1", "task_id": "task_1", "revision": 1, "expires_at": "2026-10-23T18:04:00.000Z",
    "environment": "test", "quality": {"score": 70, "signals": [{"name": "specific_category", "points": 15}]},
}
HANDOFF = {
    "status": "test_delivered", "handoff_id": "aixho_1", "handoff_url": "https://aix.brambles.ai/h/aixho_1", "delivered": True,
    "aix_param": "aix=aixho_1", "landing_url": f"{STORE_URL}?aix=aixho_1", "receiver_preview": {},
}
SUBMIT_DESCRIPTION = (
    "Report the shopper's current shopping task to AIX. Call after any turn that states or changes "
    "what they want to buy, with intent: the task. Shopping requirements only, never personal data."
)
HANDOFF_DESCRIPTION = (
    "Report that the shopper is being sent to a store or product page (the store's own URL). "
    "Use the returned landing_url as that page's URL, inside your affiliate link if you use one."
)


def run(client, coro):
    async def go():
        async with client:
            return await coro
    return asyncio.run(go())


def one_line(text: str) -> str:
    return " ".join(text.split())


def invoke_openai(tool, client, arguments: dict):
    from agents.tool_context import ToolContext

    args = json.dumps(arguments)
    ctx = ToolContext(context=None, tool_name=tool.name, tool_call_id="call_1", tool_arguments=args)
    output = run(client, tool.on_invoke_tool(ctx, args))
    return json.loads(output) if isinstance(output, str) else output


def test_openai_agents_tools_build_the_request_from_the_context():
    pytest.importorskip("agents")
    from brambles_aix.adapters.openai_agents import aix_tools

    rec = Recorder(202, ACCEPTED)
    client = AixClient(SENDER_KEY, transport=rec.transport)
    submit_intent, report_handoff = aix_tools(client, CTX)
    assert submit_intent.name == "submit_intent" and report_handoff.name == "report_handoff"
    assert one_line(submit_intent.description) == SUBMIT_DESCRIPTION
    assert one_line(report_handoff.description) == HANDOFF_DESCRIPTION
    # The model supplies only the task and the store's URL.
    assert set(submit_intent.params_json_schema["properties"]) == {"intent"}
    assert set(submit_intent.params_json_schema["$defs"]["Intent"]["properties"]) == {"task"}
    assert set(report_handoff.params_json_schema["properties"]) == {"destination_url"}

    assert invoke_openai(submit_intent, client, {"intent": {"task": TASK}}) == ACCEPTED
    assert rec.sent_json() == {"session_id": "conv_123", "task": TASK, "country": "US", "privacy": {"gpc": True}}

    rec2 = Recorder(200, HANDOFF)
    client2 = AixClient(SENDER_KEY, transport=rec2.transport)
    assert invoke_openai(aix_tools(client2, CTX)[1], client2, {"destination_url": STORE_URL}) == HANDOFF
    assert str(rec2.requests[0].url) == "https://aix.brambles.ai/api/aix/handoffs"
    assert rec2.sent_json() == {"session_id": "conv_123", "destination_url": STORE_URL, "consent": "granted"}


def test_openai_agents_tools_drop_a_null_budget_and_empty_context_values():
    pytest.importorskip("agents")
    from brambles_aix.adapters.openai_agents import aix_tools

    rec = Recorder(202, ACCEPTED)
    client = AixClient(SENDER_KEY, transport=rec.transport)
    submit_intent, _ = aix_tools(client, {"session_id": "conv_9", "country": None, "consent": None, "privacy": None})
    invoke_openai(submit_intent, client, {"intent": {"task": {**TASK, "budget": None}}})
    sent = rec.sent_json()
    assert sent == {"session_id": "conv_9", "task": {k: v for k, v in TASK.items() if k != "budget"}}

    rec2 = Recorder(200, HANDOFF)
    client2 = AixClient(SENDER_KEY, transport=rec2.transport)
    invoke_openai(aix_tools(client2, {"session_id": "conv_9"})[1], client2, {"destination_url": STORE_URL})
    assert rec2.sent_json() == {"session_id": "conv_9", "destination_url": STORE_URL}


def test_langchain_tools_build_the_request_from_the_context():
    pytest.importorskip("langchain_core")
    from brambles_aix.adapters.langchain import aix_tools

    rec = Recorder(202, ACCEPTED)
    client = AixClient(SENDER_KEY, transport=rec.transport)
    submit_intent, report_handoff = aix_tools(client, CTX)
    assert submit_intent.name == "submit_intent" and report_handoff.name == "report_handoff"
    assert one_line(submit_intent.description) == SUBMIT_DESCRIPTION
    assert one_line(report_handoff.description) == HANDOFF_DESCRIPTION
    assert set(submit_intent.args) == {"intent"}
    assert set(report_handoff.args) == {"destination_url"}

    assert run(client, submit_intent.ainvoke({"intent": {"task": TASK}})) == ACCEPTED
    assert rec.sent_json() == {"session_id": "conv_123", "task": TASK, "country": "US", "privacy": {"gpc": True}}

    rec2 = Recorder(200, HANDOFF)
    client2 = AixClient(SENDER_KEY, transport=rec2.transport)
    assert run(client2, aix_tools(client2, CTX)[1].ainvoke({"destination_url": STORE_URL})) == HANDOFF
    assert rec2.sent_json() == {"session_id": "conv_123", "destination_url": STORE_URL, "consent": "granted"}


def test_langchain_tools_send_an_opt_out_on_the_intent_and_the_handoff():
    pytest.importorskip("langchain_core")
    from brambles_aix.adapters.langchain import aix_tools

    denied = {"session_id": "conv_7", "consent": "denied"}
    rec = Recorder(200, {"status": "suppressed", "reason": "privacy_signal"})
    client = AixClient(SENDER_KEY, transport=rec.transport)
    task = {"category": "Running shoes", "summary": "Wide running shoes."}
    run(client, aix_tools(client, denied)[0].ainvoke({"intent": {"task": task}}))
    assert rec.sent_json() == {"session_id": "conv_7", "task": {**task, "facts": []}, "privacy": {"consent": "denied"}}

    rec2 = Recorder(200, {"status": "suppressed", "reason": "privacy_signal", "handoff_url": STORE_URL, "delivered": False})
    client2 = AixClient(SENDER_KEY, transport=rec2.transport)
    run(client2, aix_tools(client2, denied)[1].ainvoke({"destination_url": STORE_URL}))
    assert rec2.sent_json() == {"session_id": "conv_7", "destination_url": STORE_URL, "consent": "denied"}


def test_langchain_tools_never_raise_when_the_exchange_is_down():
    pytest.importorskip("langchain_core")
    import httpx

    from brambles_aix.adapters.langchain import aix_tools

    client = AixClient(SENDER_KEY, transport=Recorder(0, raise_error=httpx.ReadTimeout).transport)
    submit_intent, _ = aix_tools(client, CTX)
    assert run(client, submit_intent.ainvoke({"intent": {"task": TASK}})) == {"status": "skipped", "reason": "timeout"}


def test_aix_rules_end_with_the_context_line():
    rules = aix_rules(CTX)
    assert rules.startswith("You can send shopping intent to the Agentic Intent Exchange (AIX).\n")
    assert rules.endswith("\nAIX context: session_id=conv_123 country=US consent=granted")
    assert "call submit_intent with one\n  argument, intent, holding the task" in rules
    assert "If it returns a landing_url, use it as that page's URL" in rules
    assert "gpc" not in rules  # privacy signals go on the request, never into the prompt
    assert aix_rules({"session_id": "conv_9"}).endswith("\nAIX context: session_id=conv_9 country= consent=")
    assert aix_rules({"session_id": "conv_9", "country": None, "consent": None}).endswith("\nAIX context: session_id=conv_9 country= consent=")
