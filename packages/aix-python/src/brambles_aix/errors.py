"""Error type for the receiver-side and account methods and the verification helpers.

The sender-side methods (``send_intent``, ``report_handoff``, ``store_url``,
``handoff_url``, ``delete_session``) never raise: they return a ``skipped`` result instead.
``redeem_handoff`` never raises either: it returns ``{"redeemed": False, "reason": ...}``.

``code`` is the stable AIX error code when the exchange answered (``unauthorized``,
``invalid_request``, ``rate_limited``, ``ack_not_accepted``, ...), or a local code
(``timeout``, ``network``, ``no_key``, ``invalid_receipt_signature``, ...).
"""

from __future__ import annotations

from typing import Any


class AixError(Exception):
    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        status: int | None = None,
        body: Any = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message or code)
        self.code = code
        self.status = status
        self.body = body
        self.retry_after = retry_after

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"AixError(code={self.code!r}, status={self.status!r}, message={str(self)!r})"
