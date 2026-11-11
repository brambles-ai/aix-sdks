"""The AIX HTTPS client. Every call carries ``Authorization: Bearer <key>`` and a 3 second timeout.

Sender-side methods (``send_intent``, ``report_handoff``, ``store_url``, ``handoff_url``,
``delete_session``) never raise: when the exchange does not answer, or answers without a
``status``, they return ``{"status": "skipped", "reason": ...}`` so AIX can never slow down or
break the shopper's experience. ``redeem_handoff`` never raises either: a redemption must never
hold up a checkout or a page, so a failure comes back as ``{"redeemed": False, "reason": ...}``.
The other receiver methods and ``activity`` raise ``AixError``.

Each method has an async twin prefixed with ``a`` (``asend_intent``, ``areceiver_config``, ...).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal
from urllib.parse import quote

import httpx

from .errors import AixError
from .signatures import sign_acknowledgment
from .types import (
    AcknowledgmentRecorded,
    ActivityResult,
    AgentContextResponse,
    DeleteSessionResult,
    DeliveriesList,
    HandoffInput,
    HandoffNoIntent,
    HandoffResult,
    IntentAccepted,
    IntentNotStored,
    OutcomeRecorded,
    ReceiverConfig,
    Redemption,
    SenderIntent,
    Skipped,
    TestDeliveryResult,
)

AIX_API_BASE = "https://aix.brambles.ai/api/aix"
# The setup skills: "Call it from the server with a 3 second timeout and carry on normally if it fails."
DEFAULT_TIMEOUT_SECONDS = 3.0

IntentResponse = IntentAccepted | IntentNotStored | Skipped
HandoffResponse = HandoffResult | HandoffNoIntent | Skipped


@dataclass
class _Outcome:
    kind: Literal["response", "failed"]
    status: int | None = None
    body: Any = None
    reason: str | None = None


def _sender_path(outcome: _Outcome) -> Any:
    """Never raise. A JSON answer with a string ``status`` (202 accepted, 200 suppressed, 409
    no_active_intent, ...) is returned as is; everything else becomes ``skipped``."""
    if outcome.kind == "failed":
        return {"status": "skipped", "reason": outcome.reason}
    body = outcome.body
    if isinstance(body, dict) and isinstance(body.get("status"), str) and body["status"] != "skipped":
        return body
    status = outcome.status or 0
    skipped: dict[str, Any] = {"status": "skipped", "reason": f"http_{status}", "http_status": status}
    if isinstance(body, dict):
        if isinstance(body.get("error"), str):
            skipped["error"] = body["error"]
        if isinstance(body.get("retry_after"), int):
            skipped["retry_after"] = body["retry_after"]
    if 200 <= status < 300:
        skipped["reason"] = "invalid_response"
    return skipped


def _server_path(outcome: _Outcome) -> Any:
    """A 2xx JSON body is returned; anything else raises ``AixError`` with the exchange's code."""
    if outcome.kind == "failed":
        raise AixError(outcome.reason or "network", f"AIX request failed: {outcome.reason}")
    status = outcome.status or 0
    body = outcome.body
    if 200 <= status < 300:
        if body is None:
            raise AixError("invalid_response", "AIX answered without a JSON body", status=status)
        return body
    code = body["error"] if isinstance(body, dict) and isinstance(body.get("error"), str) else f"http_{status}"
    retry_after = body.get("retry_after") if isinstance(body, dict) and isinstance(body.get("retry_after"), int) else None
    raise AixError(code, f"AIX answered {status} {code}", status=status, body=body, retry_after=retry_after)


def _redemption(outcome: _Outcome) -> Redemption:
    """Never raise. A JSON body with a boolean ``redeemed`` (the 200 answers and the 404 body) is
    returned as is; anything else becomes ``{"redeemed": False, "reason": ...}`` with the exchange's
    ``reason`` or ``error`` code when the body has one, else ``timeout``, ``network`` or ``http_<status>``."""
    if outcome.kind == "failed":
        return {"redeemed": False, "reason": outcome.reason or "network"}
    body = outcome.body
    if isinstance(body, dict):
        if isinstance(body.get("redeemed"), bool):
            return body  # type: ignore[return-value]
        for field in ("reason", "error"):
            if isinstance(body.get(field), str) and body[field]:
                return {"redeemed": False, "reason": body[field]}
    return {"redeemed": False, "reason": f"http_{outcome.status or 0}"}


def _path_segment(value: str) -> str:
    return quote(str(value), safe="")


def _redeem_path(handoff_id: str) -> str:
    return f"/handoffs/{_path_segment(handoff_id)}/redeem"


def _redeem_body(via: str, client_ip: str | None, user_agent: str | None, sec_fetch_mode: str | None,
                 order_id: str | None, gpc: bool | None) -> dict[str, Any]:
    body: dict[str, Any] = {"via": via}
    for name, value in (("client_ip", client_ip), ("user_agent", user_agent), ("sec_fetch_mode", sec_fetch_mode),
                        ("order_id", order_id), ("gpc", gpc)):
        if value is not None:
            body[name] = value
    return body


def _outcome_body(converted: bool, order_value_cents: int | None) -> dict[str, Any]:
    body: dict[str, Any] = {"converted": converted}
    if order_value_cents is not None:
        body["order_value_cents"] = order_value_cents
    return body


def _parse(response: httpx.Response) -> _Outcome:
    try:
        body = response.json() if response.content else None
    except ValueError:
        body = None
    return _Outcome("response", status=response.status_code, body=body)


def _failed(error: Exception) -> _Outcome:
    reason = "timeout" if isinstance(error, httpx.TimeoutException) else "network"
    return _Outcome("failed", reason=reason)


def _since(value: str | datetime | None) -> str | None:
    if isinstance(value, datetime):
        value = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"
    return value


def resolve_store_url(result: Mapping[str, Any], destination_url: str) -> str:
    """The store URL to put inside your own link (affiliate, ad or plain): the answer's
    ``landing_url`` (the store URL with ``aix=<handoff id>`` added) when a store would pay, else
    the original ``destination_url`` unchanged. Add it before any affiliate or ad wrapping.
    Mirrors ``storeUrlForLink()`` in the send-intent skill's TypeScript reference."""
    landing_url = result.get("landing_url")
    if result.get("status") != "skipped" and isinstance(landing_url, str) and landing_url:
        return landing_url
    return destination_url


def resolve_handoff_url(result: Mapping[str, Any], destination_url: str) -> str:
    """For senders with no link system of their own: AIX's ``handoff_url`` when it answered (an
    AIX link when a store would pay, otherwise the original link, as for ``409 no_active_intent``),
    else the original link. If you have your own link, use ``resolve_store_url`` instead."""
    if result.get("status") != "skipped" and isinstance(result.get("handoff_url"), str):
        return result["handoff_url"]
    return destination_url


def describe_key(key: str | None) -> dict[str, str] | None:
    """What a key is for, from its documented prefix (``aix_<test|live>_<pk|rk>_...``); ``None`` otherwise.
    Sandbox keys never reach a real store, never earn and never spend."""
    match = re.match(r"^aix_(test|live)_(pk|rk)_", key or "")
    if not match:
        return None
    return {"environment": match.group(1), "role": "sender" if match.group(2) == "pk" else "receiver"}


class AixClient:
    """Client for the AIX v1 API with sync methods and ``a``-prefixed async twins.

    ``key`` is a sender key (``aix_test_pk_...`` / ``aix_live_pk_...``) or a receiver key
    (``aix_test_rk_...`` / ``aix_live_rk_...``). Pass ``os.environ.get("AIX_SENDER_KEY")``
    directly: when it is ``None`` sender-side calls return ``skipped`` with reason ``no_key``,
    ``redeem_handoff`` returns ``{"redeemed": False, "reason": "no_key"}`` and the other receiver
    calls raise ``AixError("no_key")``. Never invent a key or ask the shopper for one.

    ``transport`` (and ``async_transport``) exist for tests: pass an ``httpx.MockTransport``.
    """

    def __init__(
        self,
        key: str | None,
        *,
        base_url: str = AIX_API_BASE,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
        async_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._key = key or None
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport if isinstance(transport, httpx.BaseTransport) else None
        if async_transport is not None:
            self._async_transport: httpx.AsyncBaseTransport | None = async_transport
        else:
            self._async_transport = transport if isinstance(transport, httpx.AsyncBaseTransport) else None
        self._sync: httpx.Client | None = None
        self._async: httpx.AsyncClient | None = None

    # --- lifecycle ---------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self._key}", "accept": "application/json"}

    def _client(self) -> httpx.Client:
        if self._sync is None:
            self._sync = httpx.Client(timeout=self._timeout, transport=self._transport)
        return self._sync

    def _aclient(self) -> httpx.AsyncClient:
        if self._async is None:
            self._async = httpx.AsyncClient(timeout=self._timeout, transport=self._async_transport)
        return self._async

    def close(self) -> None:
        if self._sync is not None:
            self._sync.close()
            self._sync = None

    async def aclose(self) -> None:
        if self._async is not None:
            await self._async.aclose()
            self._async = None

    def __enter__(self) -> AixClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    async def __aenter__(self) -> AixClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # --- transport ----------------------------------------------------------------

    def _request(self, method: str, path: str, *, params: Mapping[str, Any] | None = None, json_body: Any = None) -> _Outcome:
        if not self._key:
            return _Outcome("failed", reason="no_key")
        query = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            response = self._client().request(method, f"{self._base_url}{path}", params=query, json=json_body, headers=self._headers())
        except httpx.HTTPError as error:
            return _failed(error)
        return _parse(response)

    async def _arequest(self, method: str, path: str, *, params: Mapping[str, Any] | None = None, json_body: Any = None) -> _Outcome:
        if not self._key:
            return _Outcome("failed", reason="no_key")
        query = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            response = await self._aclient().request(method, f"{self._base_url}{path}", params=query, json=json_body, headers=self._headers())
        except httpx.HTTPError as error:
            return _failed(error)
        return _parse(response)

    # --- Sending (sender key). Never raise. -------------------------------------

    def send_intent(self, intent: SenderIntent | Mapping[str, Any]) -> IntentResponse:
        """``POST /intents``: the shopper's current shopping task for one session (send ``task`` or ``message``)."""
        return _sender_path(self._request("POST", "/intents", json_body=dict(intent)))

    async def asend_intent(self, intent: SenderIntent | Mapping[str, Any]) -> IntentResponse:
        return _sender_path(await self._arequest("POST", "/intents", json_body=dict(intent)))

    def report_handoff(self, handoff: HandoffInput | Mapping[str, Any]) -> HandoffResponse:
        """``POST /handoffs``: the assistant is sending the shopper to a store. ``destination_url``
        is the store's own page URL, even when you send the shopper through an affiliate or ad link.

        When a store would pay (``delivers_on_click``) the answer carries ``aix_param``
        (``aix=<handoff id>``): keep your own link and add it to the store URL inside it, before you
        wrap it; ``landing_url`` is the store URL with it added. ``handoff_url`` is the alternative
        when you have no link of your own. Never open or prefetch either from your server."""
        return _sender_path(self._request("POST", "/handoffs", json_body=dict(handoff)))

    async def areport_handoff(self, handoff: HandoffInput | Mapping[str, Any]) -> HandoffResponse:
        return _sender_path(await self._arequest("POST", "/handoffs", json_body=dict(handoff)))

    def store_url(self, handoff: HandoffInput | Mapping[str, Any]) -> str:
        """Report the handoff and return the store URL to put inside your own link: ``landing_url``
        when the answer has one, otherwise the original ``destination_url``. Never raises."""
        return resolve_store_url(self.report_handoff(handoff), str(handoff["destination_url"]))

    async def astore_url(self, handoff: HandoffInput | Mapping[str, Any]) -> str:
        return resolve_store_url(await self.areport_handoff(handoff), str(handoff["destination_url"]))

    def handoff_url(self, handoff: HandoffInput | Mapping[str, Any]) -> str:
        """For senders with no link of their own: report the handoff and return ``handoff_url`` (an
        AIX link that delivers on the shopper's click when a store would pay), or the original link
        when AIX did not answer. If you have your own link, use ``store_url``."""
        return resolve_handoff_url(self.report_handoff(handoff), str(handoff["destination_url"]))

    async def ahandoff_url(self, handoff: HandoffInput | Mapping[str, Any]) -> str:
        return resolve_handoff_url(await self.areport_handoff(handoff), str(handoff["destination_url"]))

    def delete_session(self, session_id: str) -> DeleteSessionResult | Skipped:
        """``POST /privacy/delete``: a shopper's deletion request for one session. Safe to repeat."""
        return _sender_path(self._request("POST", "/privacy/delete", json_body={"session_id": session_id}))

    async def adelete_session(self, session_id: str) -> DeleteSessionResult | Skipped:
        return _sender_path(await self._arequest("POST", "/privacy/delete", json_body={"session_id": session_id}))

    # --- Account (either key). Raise AixError. ----------------------------------

    def activity(self, days: int | None = None) -> ActivityResult:
        """``GET /activity?days=N`` (1 to 90, default 30): ``SenderActivity`` for a sender key,
        ``ReceiverActivity`` for a receiver key."""
        return _server_path(self._request("GET", "/activity", params={"days": days}))

    async def aactivity(self, days: int | None = None) -> ActivityResult:
        return _server_path(await self._arequest("GET", "/activity", params={"days": days}))

    # --- Receiving (receiver key). Raise AixError. ------------------------------

    def receiver_config(self) -> ReceiverConfig:
        """``GET /receiver/config``. Server only: keep ``receiver_secret`` in your secret store."""
        return _server_path(self._request("GET", "/receiver/config"))

    async def areceiver_config(self) -> ReceiverConfig:
        return _server_path(await self._arequest("GET", "/receiver/config"))

    def list_deliveries(self, limit: int | None = None, since: str | datetime | None = None) -> DeliveriesList:
        """``GET /deliveries?limit=&since=`` (pull mode): ``DeliverySummary`` rows, newest first."""
        return _server_path(self._request("GET", "/deliveries", params={"limit": limit, "since": _since(since)}))

    async def alist_deliveries(self, limit: int | None = None, since: str | datetime | None = None) -> DeliveriesList:
        return _server_path(await self._arequest("GET", "/deliveries", params={"limit": limit, "since": _since(since)}))

    def get_delivery(self, receipt_id: str) -> AgentContextResponse:
        """``GET /deliveries/{receipt_id}``: the verified agent context. Fetching does not acknowledge use."""
        return _server_path(self._request("GET", f"/deliveries/{_path_segment(receipt_id)}"))

    async def aget_delivery(self, receipt_id: str) -> AgentContextResponse:
        return _server_path(await self._arequest("GET", f"/deliveries/{_path_segment(receipt_id)}"))

    def acknowledge(self, payload: Mapping[str, Any], receiver_secret_hex: str) -> AcknowledgmentRecorded:
        """Sign the acknowledgment with the receiver secret (``aix-ack-v1``) and ``POST /deliveries/ack``.

        ``payload`` carries ``reference`` and ``event`` (``verified`` or ``applied``), optionally
        ``application`` and ``occurred_at``."""
        signed = sign_acknowledgment(payload, receiver_secret_hex)
        return _server_path(self._request("POST", "/deliveries/ack", json_body=signed))

    async def aacknowledge(self, payload: Mapping[str, Any], receiver_secret_hex: str) -> AcknowledgmentRecorded:
        signed = sign_acknowledgment(payload, receiver_secret_hex)
        return _server_path(await self._arequest("POST", "/deliveries/ack", json_body=signed))

    def redeem_handoff(
        self,
        handoff_id: str,
        *,
        via: Literal["landing", "checkout", "agent"],
        client_ip: str | None = None,
        user_agent: str | None = None,
        sec_fetch_mode: str | None = None,
        order_id: str | None = None,
        gpc: bool | None = None,
    ) -> Redemption:
        """``POST /handoffs/{handoff_id}/redeem``: redeem an AIX handoff id that reached your store.

        ``via="landing"``: your server read ``?aix=<handoff_id>`` on the shopper's landing; send that
        request's ``client_ip`` and ``user_agent`` and, when the browser sent one, ``sec_fetch_mode``.
        ``via="checkout"`` or ``via="agent"``: an agent's checkout or conversation completed an order;
        send your ``order_id``. Pass ``gpc=True`` when the landing request carried ``Sec-GPC: 1``:
        nothing is delivered or charged.

        Never raises, so a redemption can never hold up a checkout or a page. A failure returns
        ``{"redeemed": False, "reason": ...}``: the exchange's code (``order_required``,
        ``visitor_required``, ``unknown_handoff``, ``expired``, ...) or ``no_key``, ``timeout``,
        ``network`` or ``http_<status>``."""
        try:
            return _redemption(self._request("POST", _redeem_path(handoff_id), json_body=_redeem_body(via, client_ip, user_agent, sec_fetch_mode, order_id, gpc)))
        except Exception:  # a redemption never raises
            return {"redeemed": False, "reason": "network"}

    async def aredeem_handoff(
        self,
        handoff_id: str,
        *,
        via: Literal["landing", "checkout", "agent"],
        client_ip: str | None = None,
        user_agent: str | None = None,
        sec_fetch_mode: str | None = None,
        order_id: str | None = None,
        gpc: bool | None = None,
    ) -> Redemption:
        try:
            return _redemption(await self._arequest("POST", _redeem_path(handoff_id), json_body=_redeem_body(via, client_ip, user_agent, sec_fetch_mode, order_id, gpc)))
        except Exception:  # a redemption never raises
            return {"redeemed": False, "reason": "network"}

    def report_outcome(self, receipt_id: str, *, converted: bool, order_value_cents: int | None = None) -> OutcomeRecorded:
        """``POST /deliveries/{receipt_id}/outcome``: report a sale, or no sale, after a delivery you
        verified. ``order_value_cents`` counts only with ``converted=True``; a later report replaces
        the earlier one. Raises ``AixError`` (``verified_delivery_required`` when the receipt is
        unknown to this key or not verified yet)."""
        return _server_path(self._request("POST", f"/deliveries/{_path_segment(receipt_id)}/outcome", json_body=_outcome_body(converted, order_value_cents)))

    async def areport_outcome(self, receipt_id: str, *, converted: bool, order_value_cents: int | None = None) -> OutcomeRecorded:
        return _server_path(await self._arequest("POST", f"/deliveries/{_path_segment(receipt_id)}/outcome", json_body=_outcome_body(converted, order_value_cents)))

    def request_test_delivery(self) -> TestDeliveryResult:
        """``POST /test-deliveries``: a free, signed test delivery to your sandbox receiving agent
        (sandbox keys only). ``delivery`` is ``webhook`` when your sandbox webhook URL is set, else ``pull``."""
        return _server_path(self._request("POST", "/test-deliveries"))

    async def arequest_test_delivery(self) -> TestDeliveryResult:
        return _server_path(await self._arequest("POST", "/test-deliveries"))
