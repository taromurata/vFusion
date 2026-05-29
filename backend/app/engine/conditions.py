"""Condition node — evaluates a single boolean expression on the trigger
or any prior step's output, then gates downstream edges via
``branch="true"`` / ``branch="false"``.

For Phase 3b.4 we support one comparison per condition with these operators:
- ``equals`` / ``not_equals`` — case-insensitive when both sides are strings
- ``contains`` / ``not_contains`` — substring; case-insensitive
- ``exists`` / ``not_exists`` — non-empty / empty check on the left side
- ``gt`` / ``lt`` / ``gte`` / ``lte`` — numeric, lenient float parsing

Both sides accept ``{{ … }}`` template references; only the left side
is required.
"""

from typing import Any

from app.engine.templates import resolve_deep


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "left",
            "label": "Left value",
            "type": "text",
            "required": True,
            "help": 'Usually a {{ trigger.data.* }} or {{ steps.*.output.* }} reference.',
        },
        {
            "name": "operator",
            "label": "Operator",
            "type": "operator",
            "required": True,
        },
        {
            "name": "right",
            "label": "Right value",
            "type": "text",
            "required": False,
            "help": "Not used for exists / not_exists.",
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "kind": "condition",
    "matched": True,
    "left": "...",
    "operator": "equals",
    "right": "...",
}


OPERATORS = (
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "contains_all",
    "contains_any",
    "exists",
    "not_exists",
    "gt",
    "gte",
    "lt",
    "lte",
)


def _norm(v: Any) -> str:
    """Normalize a scalar to a lowercased string token for loose
    equality. JSON booleans become ``"true"`` / ``"false"`` so a
    Gemini field that comes back as the boolean ``true`` matches a
    condition written against the string ``"true"`` (the common
    case — operators type "true" in the right-hand box, but the
    model returns a real bool). Ints/floats normalize too so
    ``5`` == ``"5"``."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        # 5 and 5.0 both -> "5" so numeric strings line up.
        return str(int(v)) if float(v).is_integer() else str(v)
    return str(v).strip().casefold()


def _eq_ci(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    # Loose, type-coercing equality: compare normalized string tokens
    # so bool/number/string forms of the same value match. Without
    # this, ``obstructed: true`` (JSON bool) never equals the string
    # ``"true"`` in a condition and the downstream branch silently
    # never fires.
    return _norm(a) == _norm(b)


def _contains_ci(haystack: Any, needle: Any) -> bool:
    if not isinstance(haystack, str) or not isinstance(needle, str):
        return False
    return needle.casefold() in haystack.casefold()


def _tokens(right: Any) -> list[str]:
    """Split the right-hand value into individual words for the
    ``contains_all`` / ``contains_any`` operators. Splits on whitespace
    *and* commas so "casey keller", "casey, keller", and "casey,keller"
    all yield ["casey", "keller"]. Lets a match succeed regardless of
    word order — e.g. a license that reads "keller, casey edward" still
    matches a target of "casey keller"."""
    if not isinstance(right, str):
        return []
    raw = right.replace(",", " ").split()
    return [t.casefold() for t in raw if t]


def _contains_all(haystack: Any, right: Any) -> bool:
    if not isinstance(haystack, str):
        return False
    hay = haystack.casefold()
    toks = _tokens(right)
    return bool(toks) and all(t in hay for t in toks)


def _contains_any(haystack: Any, right: Any) -> bool:
    if not isinstance(haystack, str):
        return False
    hay = haystack.casefold()
    toks = _tokens(right)
    return any(t in hay for t in toks)


def _try_float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _compare(left: Any, op: str, right: Any) -> bool:
    if op == "equals":
        return _eq_ci(left, right)
    if op == "not_equals":
        return not _eq_ci(left, right)
    if op == "contains":
        return _contains_ci(left, right)
    if op == "not_contains":
        return not _contains_ci(left, right)
    if op == "contains_all":
        return _contains_all(left, right)
    if op == "contains_any":
        return _contains_any(left, right)
    if op == "exists":
        return left is not None and left != "" and left != []
    if op == "not_exists":
        return left is None or left == "" or left == []
    a = _try_float(left)
    b = _try_float(right)
    if a is None or b is None:
        return False
    if op == "gt":
        return a > b
    if op == "gte":
        return a >= b
    if op == "lt":
        return a < b
    if op == "lte":
        return a <= b
    return False


def evaluate(config: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """Resolve both sides against ``ctx`` and compute the boolean result."""
    operator = (config.get("operator") or "equals").strip().lower()
    if operator not in OPERATORS:
        raise ValueError(f"unknown operator: {operator!r}")
    left = resolve_deep(config.get("left"), ctx)
    right = resolve_deep(config.get("right"), ctx)
    matched = _compare(left, operator, right)
    return {
        "kind": "condition",
        "matched": matched,
        "left": left,
        "operator": operator,
        "right": right,
    }
