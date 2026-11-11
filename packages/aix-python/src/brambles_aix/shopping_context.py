"""Validation of ``aix.shopping-context.v1`` against ``spec/shopping-context.v1.schema.json``,
including the two rules its descriptions state in prose: a ``specified`` budget has a
currency and at least one bound with ``min_cents <= max_cents`` (otherwise currency and
both bounds are null), and ``expires_at`` is later than ``updated_at``.

The exchange's own validator also checks turn ranges and that observation times do not
exceed ``updated_at``. The public schema is silent on those, so they are not enforced here.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime
from typing import Any, NoReturn

from .errors import AixError
from .types import ShoppingContext

_FACT_ATTRIBUTES = ("brand", "width", "size", "department", "use_case", "feature", "merchant", "deal")
_FACT_STRENGTHS = ("required", "preferred", "excluded")
_BUDGET_STATUSES = ("specified", "not_specified", "cleared")
_SCOPES = ("controlled_pilot", "exchange_beta")
_ALLOWED_USES = ("onsite_personalization", "agent_continuity", "contextual_product_ranking")
_ISO_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
_CENTS_MAX = 100_000_000


def parse_date_time(value: str) -> datetime:
    """RFC 3339 date-time to an aware ``datetime`` (``Z`` accepted on every Python version)."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _fail(path: str, message: str) -> NoReturn:
    where = f"shopping_context.{path}" if path else "shopping_context"
    raise AixError("invalid_shopping_context", f"{where}: {message}")


def _object(value: Any, path: str, required: tuple[str, ...], optional: tuple[str, ...] = ()) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(path, "must be an object")
    for key in required:
        if key not in value:
            _fail(path, f"missing {key}")
    for key in value:
        if key not in required and key not in optional:
            _fail(path, f"unexpected property {key}")
    return value


def _string(value: Any, path: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        _fail(path, f"must be a string of {minimum} to {maximum} characters")
    return value


def _one_of(value: Any, path: str, values: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in values:
        _fail(path, f"must be one of {', '.join(values)}")
    return value


def _positive_int(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        _fail(path, "must be an integer >= 1")
    return value


def _cents_or_none(value: Any, path: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= _CENTS_MAX:
        _fail(path, "must be null or an integer between 0 and 100000000")
    return value


def _date_time(value: Any, path: str) -> str:
    if not isinstance(value, str) or not _ISO_DATE_TIME.match(value):
        _fail(path, "must be an ISO 8601 date-time")
    try:
        parse_date_time(value)
    except ValueError:
        _fail(path, "must be an ISO 8601 date-time")
    return value


def validate_shopping_context(value: Any) -> ShoppingContext:
    """Raise ``AixError("invalid_shopping_context")`` with the first violation; return the typed context."""
    c = _object(value, "", (
        "schema_version", "task_id", "revision", "started_turn", "category", "summary", "budget", "facts",
        "updated_at", "expires_at", "policy", "relevance",
    ))
    if c["schema_version"] != "aix.shopping-context.v1":
        _fail("schema_version", "must be aix.shopping-context.v1")
    task_id = _string(c["task_id"], "task_id", 1, 240)
    revision = _positive_int(c["revision"], "revision")
    started_turn = _positive_int(c["started_turn"], "started_turn")

    cat = _object(c["category"], "category", ("id", "label"))
    category = {"id": _string(cat["id"], "category.id", 1, 240), "label": _string(cat["label"], "category.label", 1, 240)}
    summary = _string(c["summary"], "summary", 1, 1600)

    b = _object(c["budget"], "budget", ("status", "currency", "min_cents", "max_cents", "source_turn", "observed_at"))
    status = _one_of(b["status"], "budget.status", _BUDGET_STATUSES)
    currency = b["currency"]
    if currency is not None and (not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency)):
        _fail("budget.currency", "must be null or three upper-case letters")
    min_cents = _cents_or_none(b["min_cents"], "budget.min_cents")
    max_cents = _cents_or_none(b["max_cents"], "budget.max_cents")
    if status == "specified":
        if currency is None or (min_cents is None and max_cents is None):
            _fail("budget", "a specified budget needs a currency and at least one bound")
        if min_cents is not None and max_cents is not None and min_cents > max_cents:
            _fail("budget", "min_cents exceeds max_cents")
    elif currency is not None or min_cents is not None or max_cents is not None:
        _fail("budget", f"a {status} budget has null currency and bounds")
    budget = {
        "status": status,
        "currency": currency,
        "min_cents": min_cents,
        "max_cents": max_cents,
        "source_turn": _positive_int(b["source_turn"], "budget.source_turn"),
        "observed_at": _date_time(b["observed_at"], "budget.observed_at"),
    }

    raw_facts = c["facts"]
    if not isinstance(raw_facts, list) or len(raw_facts) > 24:
        _fail("facts", "must be an array of at most 24 facts")
    facts = []
    for index, item in enumerate(raw_facts):
        f = _object(item, f"facts[{index}]", ("attribute", "value", "strength", "provenance"))
        p = _object(f["provenance"], f"facts[{index}].provenance", ("source_turn", "observed_at", "basis"))
        if p["basis"] != "extracted_shopping_requirement":
            _fail(f"facts[{index}].provenance.basis", "must be extracted_shopping_requirement")
        facts.append({
            "attribute": _one_of(f["attribute"], f"facts[{index}].attribute", _FACT_ATTRIBUTES),
            "value": _string(f["value"], f"facts[{index}].value", 1, 240),
            "strength": _one_of(f["strength"], f"facts[{index}].strength", _FACT_STRENGTHS),
            "provenance": {
                "source_turn": _positive_int(p["source_turn"], f"facts[{index}].provenance.source_turn"),
                "observed_at": _date_time(p["observed_at"], f"facts[{index}].provenance.observed_at"),
                "basis": "extracted_shopping_requirement",
            },
        })

    updated_at = _date_time(c["updated_at"], "updated_at")
    expires_at = _date_time(c["expires_at"], "expires_at")
    if parse_date_time(expires_at) <= parse_date_time(updated_at):
        _fail("expires_at", "must be later than updated_at")

    pol = _object(c["policy"], "policy", ("scope", "allowed_uses", "cross_site_retargeting", "model_training"))
    uses = pol["allowed_uses"]
    if not isinstance(uses, list) or len(uses) > 3 or len(set(map(str, uses))) != len(uses):
        _fail("policy.allowed_uses", "must be up to three unique uses")
    allowed_uses = [_one_of(use, f"policy.allowed_uses[{i}]", _ALLOWED_USES) for i, use in enumerate(uses)]
    if pol["cross_site_retargeting"] is not False:
        _fail("policy.cross_site_retargeting", "must be false")
    if pol["model_training"] is not False:
        _fail("policy.model_training", "must be false")
    policy = {
        "scope": _one_of(pol["scope"], "policy.scope", _SCOPES),
        "allowed_uses": allowed_uses,
        "cross_site_retargeting": False,
        "model_training": False,
    }

    rel = _object(c["relevance"], "relevance", ("method", "embedding_available", "semantic_score"))
    if rel["method"] != "explicit_constraints":
        _fail("relevance.method", "must be explicit_constraints")
    if rel["embedding_available"] is not False:
        _fail("relevance.embedding_available", "must be false")
    if rel["semantic_score"] is not None:
        _fail("relevance.semantic_score", "must be null")
    relevance = {"method": "explicit_constraints", "embedding_available": False, "semantic_score": None}

    return {  # type: ignore[return-value]
        "schema_version": "aix.shopping-context.v1",
        "task_id": task_id,
        "revision": revision,
        "started_turn": started_turn,
        "category": category,
        "summary": summary,
        "budget": budget,
        "facts": facts,
        "updated_at": updated_at,
        "expires_at": expires_at,
        "policy": policy,
        "relevance": relevance,
    }
