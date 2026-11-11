import asyncio
import hashlib
import hmac
import json
from datetime import datetime, timezone

import httpx
import pytest

from brambles_aix import (
    AixClient,
    AixError,
    canonical_json,
    describe_key,
    resolve_handoff_url,
    resolve_store_url,
    verify_acknowledgment_signature,
)
from support import SENDER_KEY, RECEIVER_KEY, RECEIVER_SECRET, Recorder

INTENT = {
    "session_id": "conv_123",
    "task": {
        "category": "Running shoes",
        "summary": "Wide running shoes for daily training, cushioning preferred, up to $150.",
        "budget": {"currency": "USD", "max_cents": 15000},
        "facts": [{"attribute": "width", "value": "wide", "strength": "required"}],
    },
    "country": "US",
    "privacy": {"gpc": False},
}
ACCEPTED = {
    "status": "accepted", "intent_id": "aixint_1", "task_id": "task_1", "revision": 1,
    "expires_at": "2026-10-23T18:04:00.000Z", "environment": "test", "quality": {"score": 82, "signals": [{"name": "specific_category", "points": 15}, {"name": "budget", "points": 10}]},
}
HANDOFF = {"session_id": "conv_123", "destination_url": "https://store.example/products/wide-runner", "consent": "granted"}
HANDOFF_ID = "aixho_2f9c0d0123456789abcdef0123456789"
DELIVERS = {
    "status": "delivers_on_click", "handoff_id": HANDOFF_ID, "handoff_url": f"https://aix.brambles.ai/h/{HANDOFF_ID}",
    "aix_param": f"aix={HANDOFF_ID}", "landing_url": f"https://store.example/products/wide-runner?aix={HANDOFF_ID}",
    "delivered": False, "environment": "live", "earnings_cents": 0, "quality_score": 82,
}
REFERENCE = {
    "receipt_id": "aixdeliv_0123456789abcdef0123456789abcdef", "member_id": "aixapp_49356ce196553f361f44:test",
    "receipt_sha256": "ab" * 32, "task_id": "task_c0ffee", "revision": 3, "expires_at": "2026-10-23T18:04:00.000Z",
}


def run(coro_fn, client):
    async def go():
        async with client:
            return await coro_fn(client)
    return asyncio.run(go())


def test_send_intent_posts_with_bearer_key_and_returns_the_body():
    rec = Recorder(202, ACCEPTED)
    with AixClient(SENDER_KEY, transport=rec.transport) as client:
        assert client.send_intent(INTENT) == ACCEPTED
    request = rec.requests[0]
    assert str(request.url) == "https://aix.brambles.ai/api/aix/intents"
    assert request.method == "POST"
    assert request.headers["authorization"] == f"Bearer {SENDER_KEY}"
    assert request.headers["content-type"] == "application/json"
    assert rec.sent_json() == INTENT


def test_async_twin_sends_the_same_request():
    rec = Recorder(202, ACCEPTED)
    result = run(lambda c: c.asend_intent(INTENT), AixClient(SENDER_KEY, transport=rec.transport))
    assert result == ACCEPTED
    assert rec.sent_json() == INTENT
    assert rec.requests[0].headers["authorization"] == f"Bearer {SENDER_KEY}"


def test_custom_base_url_trailing_slash_is_trimmed():
    rec = Recorder(202, ACCEPTED)
    AixClient(SENDER_KEY, base_url="https://sandbox.example/api/aix/", transport=rec.transport).send_intent(INTENT)
    assert str(rec.requests[0].url) == "https://sandbox.example/api/aix/intents"


def test_not_stored_200_is_returned_as_is():
    body = {"status": "suppressed", "reason": "sensitive_category", "sensitive_class": "health"}
    assert AixClient(SENDER_KEY, transport=Recorder(200, body).transport).send_intent(INTENT) == body


def test_http_errors_become_skipped_results():
    assert AixClient(SENDER_KEY, transport=Recorder(400, {"error": "invalid_request", "issues": []}).transport).send_intent(INTENT) == {
        "status": "skipped", "reason": "http_400", "http_status": 400, "error": "invalid_request",
    }
    listed = [{"path": "task.category", "message": "Required"}, {"path": 7}, "x"]
    assert AixClient(SENDER_KEY, transport=Recorder(400, {"error": "invalid_request", "issues": listed}).transport).send_intent(INTENT) == {
        "status": "skipped", "reason": "http_400", "http_status": 400, "error": "invalid_request",
        "issues": [{"path": "task.category", "message": "Required"}],
    }
    limited = AixClient(SENDER_KEY, transport=Recorder(429, {"error": "rate_limited", "retry_after": 12}).transport).send_intent(INTENT)
    assert limited["reason"] == "http_429" and limited["retry_after"] == 12
    down = AixClient(SENDER_KEY, transport=Recorder(503, {"error": "extractor_unavailable"}).transport).send_intent({"session_id": "s", "message": "hi"})
    assert down["status"] == "skipped" and down["reason"] == "http_503" and down["error"] == "extractor_unavailable"
    html = AixClient(SENDER_KEY, transport=Recorder(202, raw=b"<html>").transport).send_intent(INTENT)
    assert html == {"status": "skipped", "reason": "invalid_response", "http_status": 202}


def test_network_and_timeout_failures_become_skipped_results():
    network = AixClient(SENDER_KEY, transport=Recorder(0, raise_error=httpx.ConnectError).transport)
    assert network.send_intent(INTENT) == {"status": "skipped", "reason": "network"}
    timeout = AixClient(SENDER_KEY, transport=Recorder(0, raise_error=httpx.ReadTimeout).transport)
    assert timeout.send_intent(INTENT) == {"status": "skipped", "reason": "timeout"}
    assert run(lambda c: c.asend_intent(INTENT), AixClient(SENDER_KEY, transport=Recorder(0, raise_error=httpx.ReadTimeout).transport)) == {
        "status": "skipped", "reason": "timeout",
    }


def test_default_timeout_is_three_seconds():
    client = AixClient(SENDER_KEY, transport=Recorder(202, ACCEPTED).transport)
    assert client._client().timeout == httpx.Timeout(3.0)


def test_missing_key_skips_without_a_request_and_raises_on_the_receiver_path():
    rec = Recorder(202, ACCEPTED)
    client = AixClient(None, transport=rec.transport)
    assert client.send_intent(INTENT) == {"status": "skipped", "reason": "no_key"}
    assert rec.requests == []
    with pytest.raises(AixError) as info:
        client.receiver_config()
    assert info.value.code == "no_key"


def test_report_handoff_and_handoff_url():
    body = DELIVERS
    rec = Recorder(200, body)
    client = AixClient(SENDER_KEY, transport=rec.transport)
    assert client.report_handoff(HANDOFF) == body
    assert str(rec.requests[0].url) == "https://aix.brambles.ai/api/aix/handoffs"
    assert rec.sent_json() == HANDOFF
    assert client.handoff_url(HANDOFF) == body["handoff_url"]
    no_intent = AixClient(SENDER_KEY, transport=Recorder(409, {"status": "no_active_intent", "handoff_url": HANDOFF["destination_url"]}).transport)
    assert no_intent.report_handoff(HANDOFF) == {"status": "no_active_intent", "handoff_url": HANDOFF["destination_url"]}
    assert no_intent.handoff_url(HANDOFF) == HANDOFF["destination_url"]
    dead = AixClient(SENDER_KEY, transport=Recorder(0, raise_error=httpx.ReadTimeout).transport)
    assert dead.handoff_url(HANDOFF) == HANDOFF["destination_url"]
    assert run(lambda c: c.ahandoff_url(HANDOFF), AixClient(SENDER_KEY, transport=Recorder(200, body).transport)) == body["handoff_url"]
    assert resolve_handoff_url({"status": "skipped", "reason": "no_key"}, "https://x.example/") == "https://x.example/"


def test_store_url_returns_the_landing_url_or_the_original_link():
    rec = Recorder(200, DELIVERS)
    client = AixClient(SENDER_KEY, transport=rec.transport)
    assert client.store_url(HANDOFF) == DELIVERS["landing_url"]
    assert str(rec.requests[0].url) == "https://aix.brambles.ai/api/aix/handoffs"
    assert rec.sent_json() == HANDOFF
    assert run(lambda c: c.astore_url(HANDOFF), AixClient(SENDER_KEY, transport=Recorder(200, DELIVERS).transport)) == DELIVERS["landing_url"]

    destination = HANDOFF["destination_url"]
    not_delivered = {"status": "not_delivered", "handoff_id": HANDOFF_ID, "handoff_url": destination, "delivered": False,
                     "environment": "live", "earnings_cents": 0, "quality_score": 82}
    assert AixClient(SENDER_KEY, transport=Recorder(200, not_delivered).transport).store_url(HANDOFF) == destination
    no_intent = Recorder(409, {"status": "no_active_intent", "handoff_url": destination})
    assert AixClient(SENDER_KEY, transport=no_intent.transport).store_url(HANDOFF) == destination
    for failing in (Recorder(0, raise_error=httpx.ReadTimeout), Recorder(0, raise_error=httpx.ConnectError),
                    Recorder(500, {"error": "server_error"}), Recorder(200, raw=b"<html>")):
        assert AixClient(SENDER_KEY, transport=failing.transport).store_url(HANDOFF) == destination
    assert AixClient(None).store_url(HANDOFF) == destination


def test_resolve_store_url():
    assert resolve_store_url(DELIVERS, "https://x.example/") == DELIVERS["landing_url"]
    assert resolve_store_url({"status": "not_delivered", "handoff_url": "https://x.example/", "delivered": False}, "https://x.example/") == "https://x.example/"
    assert resolve_store_url({"status": "skipped", "reason": "timeout"}, "https://x.example/") == "https://x.example/"
    assert resolve_store_url({"status": "skipped", "landing_url": "https://other.example/"}, "https://x.example/") == "https://x.example/"
    assert resolve_store_url({"status": "delivers_on_click", "landing_url": None}, "https://x.example/") == "https://x.example/"


def test_delete_session():
    body = {"status": "deleted", "environment": "test", "intents_deleted": 2, "receipts_cleared": 1}
    rec = Recorder(200, body)
    assert AixClient(SENDER_KEY, transport=rec.transport).delete_session("conv_123") == body
    assert str(rec.requests[0].url) == "https://aix.brambles.ai/api/aix/privacy/delete"
    assert rec.sent_json() == {"session_id": "conv_123"}


SENDER_ACTIVITY = {
    "principal_id": "aixapp_dcad0746ebb68099bdf7:test", "environment": "test",
    "period": {"days": 7, "from": "2026-10-15T00:00:00.000Z", "to": "2026-10-22T00:00:00.000Z"},
    "intents": {"accepted": 3, "last_accepted_at": "2026-10-21T18:04:00.000Z", "average_quality": 71},
    "handoffs": {
        "reported": 2, "delivered": 1, "awaiting_click": 0,
        "not_delivered": {"not_delivered": 1, "consent_required": 0, "delivery_failed": 0},
        "clicks_not_billed": {"expired": 0, "sender_server": 1, "too_fast": 0, "ip_velocity": 0, "low_quality": 0, "sender_cap": 2},
    },
    "earnings": {"currency": "USD", "accrued_cents": 0, "lifetime_accrued_cents": 0, "lifetime_collected_cents": 0,
                 "lifetime_paid_cents": 0, "revenue_share_bps": 0, "status": "test_mode_never_earns"},
}
RECEIVER_ACTIVITY = {
    "principal_id": "aixapp_49356ce196553f361f44:test", "environment": "test",
    "period": {"days": 30, "from": "2026-09-22T00:00:00.000Z", "to": "2026-10-22T00:00:00.000Z"},
    "deliveries": {"received": 4, "verified": 3, "applied": 1, "last_received_at": "2026-10-21T18:04:00.000Z", "first_verified_at": None},
    "spend": {"currency": "USD", "test_mode_never_charges": True},
}


def test_activity_types_match_the_documented_shapes():
    from typing import get_type_hints

    from brambles_aix import types

    def keys(typed_dict):
        return set(get_type_hints(typed_dict))

    assert keys(types.SenderActivity) == set(SENDER_ACTIVITY)
    assert keys(types.ActivityPeriod) == set(SENDER_ACTIVITY["period"])
    assert keys(types.SenderActivityIntents) == set(SENDER_ACTIVITY["intents"])
    assert keys(types.SenderActivityHandoffs) == set(SENDER_ACTIVITY["handoffs"])
    assert keys(types.HandoffsNotDelivered) == set(SENDER_ACTIVITY["handoffs"]["not_delivered"])
    assert keys(types.ClicksNotBilled) == {"expired", "sender_server", "too_fast", "ip_velocity", "low_quality", "sender_cap"}
    assert keys(types.ClicksNotBilled) == set(SENDER_ACTIVITY["handoffs"]["clicks_not_billed"])
    assert keys(types.SenderActivityEarnings) == set(SENDER_ACTIVITY["earnings"])
    assert keys(types.ReceiverActivity) == set(RECEIVER_ACTIVITY)
    assert keys(types.ReceiverActivityDeliveries) == set(RECEIVER_ACTIVITY["deliveries"])
    assert set(RECEIVER_ACTIVITY["spend"]) <= keys(types.ReceiverActivitySpend)
    assert types.ReceiverActivitySpend.__required_keys__ == {"currency"}
    assert types.IntentAccepted.__required_keys__ >= {"quality"}
    assert keys(types.QualitySignal) == {"name", "points"}

    sender = AixClient(SENDER_KEY, transport=Recorder(200, SENDER_ACTIVITY).transport).activity(days=7)
    assert sender["handoffs"]["clicks_not_billed"]["sender_cap"] == 2
    assert sender["handoffs"]["clicks_not_billed"]["sender_server"] == 1
    receiver = AixClient(RECEIVER_KEY, transport=Recorder(200, RECEIVER_ACTIVITY).transport).activity()
    assert receiver["deliveries"]["verified"] == 3 and receiver["spend"]["test_mode_never_charges"] is True


def test_activity_is_a_get_with_days():
    body = SENDER_ACTIVITY
    rec = Recorder(200, body)
    assert AixClient(SENDER_KEY, transport=rec.transport).activity(days=7) == body
    request = rec.requests[0]
    assert str(request.url) == "https://aix.brambles.ai/api/aix/activity?days=7"
    assert request.method == "GET"
    assert request.content == b""
    rec2 = Recorder(200, body)
    AixClient(SENDER_KEY, transport=rec2.transport).activity()
    assert str(rec2.requests[0].url) == "https://aix.brambles.ai/api/aix/activity"


def test_server_path_raises_aix_error_with_the_exchange_code():
    client = AixClient(RECEIVER_KEY, transport=Recorder(401, {"error": "unauthorized"}).transport)
    with pytest.raises(AixError) as info:
        client.receiver_config()
    assert info.value.code == "unauthorized" and info.value.status == 401
    with pytest.raises(AixError) as info:
        AixClient(RECEIVER_KEY, transport=Recorder(0, raise_error=httpx.ReadTimeout).transport).list_deliveries()
    assert info.value.code == "timeout"
    with pytest.raises(AixError) as info:
        AixClient(RECEIVER_KEY, transport=Recorder(429, {"error": "rate_limited", "retry_after": 5}).transport).activity()
    assert info.value.code == "rate_limited" and info.value.retry_after == 5
    with pytest.raises(AixError) as info:
        AixClient(RECEIVER_KEY, transport=Recorder(200).transport).receiver_config()
    assert info.value.code == "invalid_response"


def test_receiver_config_and_deliveries():
    config = {"member_id": "aixapp_x:test", "issuer": "https://aix.brambles.ai", "receiver_secret": RECEIVER_SECRET,
              "signature_scheme": "aix-hmac-sha256-v1", "acknowledgment_url": "https://aix.brambles.ai/api/aix/deliveries/ack"}
    rec = Recorder(200, config)
    assert AixClient(RECEIVER_KEY, transport=rec.transport).receiver_config() == config
    assert str(rec.requests[0].url) == "https://aix.brambles.ai/api/aix/receiver/config"

    listing = {"deliveries": [{"receipt_id": REFERENCE["receipt_id"], "intent_id": "aixint_0123456789abcdef0123456789abcdef",
                               "destination_domain": "store.example", "price_cents": 0, "status": "pending",
                               "created_at": "2026-10-22T18:04:03.000Z"}], "delivery_mode": "pull"}
    rec = Recorder(200, listing)
    since = datetime(2026, 10, 22, tzinfo=timezone.utc)
    assert AixClient(RECEIVER_KEY, transport=rec.transport).list_deliveries(limit=5, since=since) == listing
    assert rec.requests[0].url.params["limit"] == "5"
    assert rec.requests[0].url.params["since"] == "2026-10-22T00:00:00.000Z"
    assert run(lambda c: c.alist_deliveries(), AixClient(RECEIVER_KEY, transport=Recorder(200, listing).transport)) == listing

    context = {"reference": REFERENCE, "schema_version": "aix.agent-context.v1", "brief": "...", "shopping_context": {}, "activation": {}, "events": []}
    rec = Recorder(200, context)
    assert AixClient(RECEIVER_KEY, transport=rec.transport).get_delivery(REFERENCE["receipt_id"]) == context
    assert str(rec.requests[0].url) == f"https://aix.brambles.ai/api/aix/deliveries/{REFERENCE['receipt_id']}"


def test_acknowledge_signs_with_the_receiver_secret_and_posts():
    recorded = {"ok": True, "event_id": "aixevt_" + "3b" * 32, "receipt_id": REFERENCE["receipt_id"],
                "event": "verified", "application": "none", "duplicate": False}
    rec = Recorder(200, recorded)
    client = AixClient(RECEIVER_KEY, transport=rec.transport)
    assert client.acknowledge({"reference": REFERENCE, "event": "verified", "occurred_at": "2026-10-22T18:05:12.000Z"}, RECEIVER_SECRET) == recorded
    assert str(rec.requests[0].url) == "https://aix.brambles.ai/api/aix/deliveries/ack"
    sent = rec.sent_json()
    assert list(sent["payload"]) == ["schema_version", "reference", "event", "application", "occurred_at"]
    assert sent["payload"]["application"] == "none"
    expected = hmac.new(bytes.fromhex(RECEIVER_SECRET), f"aix-ack-v1\n{canonical_json(sent['payload'])}".encode(), hashlib.sha256).hexdigest()
    assert sent["signature"] == expected
    assert verify_acknowledgment_signature(sent, RECEIVER_SECRET)
    with pytest.raises(AixError) as info:
        AixClient(RECEIVER_KEY, transport=Recorder(409, {"error": "ack_not_accepted"}).transport).acknowledge(
            {"reference": REFERENCE, "event": "applied", "application": "agent_context_loaded"}, RECEIVER_SECRET)
    assert info.value.code == "ack_not_accepted" and info.value.status == 409
    asynced = Recorder(200, {"ok": True})
    run(lambda c: c.aacknowledge({"reference": REFERENCE, "event": "verified"}, RECEIVER_SECRET), AixClient(RECEIVER_KEY, transport=asynced.transport))
    assert verify_acknowledgment_signature(asynced.sent_json(), RECEIVER_SECRET)


def test_request_test_delivery():
    body = {"receipt_id": REFERENCE["receipt_id"], "environment": "test", "member_id": REFERENCE["member_id"],
            "delivery": "pull", "status": "pending", "error": None, "acknowledged": False,
            "context_url": f"https://aix.brambles.ai/api/aix/deliveries/{REFERENCE['receipt_id']}"}
    rec = Recorder(201, body)
    assert AixClient(RECEIVER_KEY, transport=rec.transport).request_test_delivery() == body
    assert str(rec.requests[0].url) == "https://aix.brambles.ai/api/aix/test-deliveries"
    assert rec.requests[0].method == "POST"


REDEEM_URL = f"https://aix.brambles.ai/api/aix/handoffs/{HANDOFF_ID}/redeem"
REDEEMED = {"redeemed": True, "receipt_id": REFERENCE["receipt_id"],
            "context_url": f"https://aix.brambles.ai/api/aix/deliveries/{REFERENCE['receipt_id']}"}


def test_redeem_handoff_for_a_landing_sends_the_visitor():
    rec = Recorder(200, REDEEMED)
    client = AixClient(RECEIVER_KEY, transport=rec.transport)
    result = client.redeem_handoff(HANDOFF_ID, via="landing", client_ip="203.0.113.7", user_agent="Mozilla/5.0", sec_fetch_mode="navigate")
    assert result == REDEEMED
    request = rec.requests[0]
    assert str(request.url) == REDEEM_URL and request.method == "POST"
    assert request.headers["authorization"] == f"Bearer {RECEIVER_KEY}"
    assert rec.sent_json() == {"via": "landing", "client_ip": "203.0.113.7", "user_agent": "Mozilla/5.0", "sec_fetch_mode": "navigate"}

    minimal = Recorder(200, REDEEMED)
    AixClient(RECEIVER_KEY, transport=minimal.transport).redeem_handoff(HANDOFF_ID, via="landing", client_ip="203.0.113.7", user_agent="Mozilla/5.0")
    assert minimal.sent_json() == {"via": "landing", "client_ip": "203.0.113.7", "user_agent": "Mozilla/5.0"}

    declined = Recorder(200, {"redeemed": False, "reason": "privacy_signal"})
    assert AixClient(RECEIVER_KEY, transport=declined.transport).redeem_handoff(HANDOFF_ID, via="landing", gpc=True) == {
        "redeemed": False, "reason": "privacy_signal",
    }
    assert declined.sent_json() == {"via": "landing", "gpc": True}


def test_redeem_handoff_for_a_completed_order_sends_the_order_id():
    rec = Recorder(200, {**REDEEMED, "duplicate": True})
    assert AixClient(RECEIVER_KEY, transport=rec.transport).redeem_handoff(HANDOFF_ID, via="checkout", order_id="order_1001") == {**REDEEMED, "duplicate": True}
    assert str(rec.requests[0].url) == REDEEM_URL
    assert rec.sent_json() == {"via": "checkout", "order_id": "order_1001"}

    agent = Recorder(200, {**REDEEMED, "test": True})
    result = run(lambda c: c.aredeem_handoff(HANDOFF_ID, via="agent", order_id="order_1002"), AixClient(RECEIVER_KEY, transport=agent.transport))
    assert result == {**REDEEMED, "test": True}
    assert agent.sent_json() == {"via": "agent", "order_id": "order_1002"}


def test_redeem_handoff_returns_failures_and_never_raises():
    def redeem(recorder, **kwargs):
        return AixClient(RECEIVER_KEY, transport=recorder.transport).redeem_handoff(HANDOFF_ID, **({"via": "checkout"} | kwargs))

    assert redeem(Recorder(400, {"error": "order_required"})) == {"redeemed": False, "reason": "order_required"}
    assert redeem(Recorder(400, {"error": "visitor_required", "required": ["client_ip", "user_agent"]}), via="landing") == {
        "redeemed": False, "reason": "visitor_required",
    }
    not_found = {"redeemed": False, "reason": "unknown_handoff"}
    assert redeem(Recorder(404, not_found), order_id="order_1") == not_found
    assert redeem(Recorder(200, {"redeemed": False, "reason": "expired"}), order_id="order_1") == {"redeemed": False, "reason": "expired"}
    assert redeem(Recorder(403, {"error": "insufficient_scope", "required": "claim"}), order_id="order_1") == {"redeemed": False, "reason": "insufficient_scope"}
    assert redeem(Recorder(429, {"error": "rate_limited", "retry_after": 5}), order_id="order_1") == {"redeemed": False, "reason": "rate_limited"}
    assert redeem(Recorder(0, raise_error=httpx.ReadTimeout), order_id="order_1") == {"redeemed": False, "reason": "timeout"}
    assert redeem(Recorder(0, raise_error=httpx.ConnectError), order_id="order_1") == {"redeemed": False, "reason": "network"}
    assert redeem(Recorder(502, raw=b"<html>Bad gateway</html>"), order_id="order_1") == {"redeemed": False, "reason": "http_502"}
    assert redeem(Recorder(500), order_id="order_1") == {"redeemed": False, "reason": "http_500"}
    assert redeem(Recorder(200, raw=b"<html>"), order_id="order_1") == {"redeemed": False, "reason": "http_200"}
    assert redeem(Recorder(200, {"redeemed": "yes"}), order_id="order_1") == {"redeemed": False, "reason": "http_200"}

    silent = Recorder(200, REDEEMED)
    assert AixClient(None, transport=silent.transport).redeem_handoff(HANDOFF_ID, via="checkout", order_id="order_1") == {"redeemed": False, "reason": "no_key"}
    assert silent.requests == []
    timed_out = AixClient(RECEIVER_KEY, transport=Recorder(0, raise_error=httpx.ReadTimeout).transport)
    assert run(lambda c: c.aredeem_handoff(HANDOFF_ID, via="checkout", order_id="order_1"), timed_out) == {"redeemed": False, "reason": "timeout"}


def test_report_outcome():
    receipt_id = REFERENCE["receipt_id"]
    body = {"ok": True, "receipt_id": receipt_id, "converted": True, "order_value_cents": 12999}
    rec = Recorder(200, body)
    assert AixClient(RECEIVER_KEY, transport=rec.transport).report_outcome(receipt_id, converted=True, order_value_cents=12999) == body
    request = rec.requests[0]
    assert str(request.url) == f"https://aix.brambles.ai/api/aix/deliveries/{receipt_id}/outcome" and request.method == "POST"
    assert request.headers["authorization"] == f"Bearer {RECEIVER_KEY}"
    assert rec.sent_json() == {"converted": True, "order_value_cents": 12999}

    no_sale = Recorder(200, {"ok": True, "receipt_id": receipt_id, "converted": False, "order_value_cents": None})
    run(lambda c: c.areport_outcome(receipt_id, converted=False), AixClient(RECEIVER_KEY, transport=no_sale.transport))
    assert no_sale.sent_json() == {"converted": False}

    with pytest.raises(AixError) as info:
        AixClient(RECEIVER_KEY, transport=Recorder(409, {"error": "verified_delivery_required"}).transport).report_outcome(receipt_id, converted=True)
    assert info.value.code == "verified_delivery_required" and info.value.status == 409
    with pytest.raises(AixError) as info:
        AixClient(RECEIVER_KEY, transport=Recorder(0, raise_error=httpx.ReadTimeout).transport).report_outcome(receipt_id, converted=True)
    assert info.value.code == "timeout"


def test_describe_key():
    assert describe_key(SENDER_KEY) == {"environment": "test", "role": "sender"}
    assert describe_key("aix_live_rk_abcdef01_x") == {"environment": "live", "role": "receiver"}
    assert describe_key("sk_live_nope") is None
    assert describe_key(None) is None
