"""Action: pull current weather from OpenWeatherMap.

Calls the OpenWeatherMap free-tier ``/data/2.5/weather`` endpoint with
either a ``lat`` + ``lon`` pair OR a ``zip`` code (the API accepts both;
zip is friendlier for operators who don't have GPS coords handy). Pairs
naturally with a schedule trigger + a downstream verkada_helix_event
step that logs the result to a Helix "Weather" event type.

The output is shaped so downstream Helix attributes can map cleanly:

    {
        "json": {
            "conditions":      "broken clouds",
            "temp":            54.3,
            "feels_like":      51.2,
            "humidity":        78,
            "pressure":        1015,
            "wind_speed":      8.2,
            "wind_direction":  180,
            "visibility":      10000,
            "location":        "Tacoma, US",
            "units":           "imperial",
        },
        "text": "broken clouds, 54.3°F (feels like 51.2°F), wind 8.2 mph",
    }

Units default to ``imperial`` (°F, mph) to match the legacy script this
action replaces; flip to ``metric`` for °C + m/s.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.crypto import decrypt_secret
from app.engine.templates import resolve_deep
from app.models import Connection


logger = logging.getLogger(__name__)


_OWM_BASE = "https://api.openweathermap.org/data/2.5/weather"
_DEFAULT_UNITS = "imperial"


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "connection_id",
            "label": "OpenWeatherMap connection",
            "type": "connection_ref",
            "connection_type": "openweathermap",
            "required": True,
        },
        {
            "name": "zip",
            "label": "Zip code (US)",
            "type": "text",
            "required": False,
            "help": "5-digit US zip — e.g. 98404. Easiest path for most operators. Leave blank if you'd rather use lat/lon below.",
        },
        {
            "name": "country",
            "label": "Country code",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Two-letter ISO country code paired with the zip — defaults to US.",
        },
        {
            "name": "latitude",
            "label": "Latitude",
            "type": "text",
            "required": False,
            "help": "Use lat/lon when a zip isn't precise enough (e.g. a specific yard or job site). Either fill both lat + lon, or fill the zip above — don't need both.",
        },
        {
            "name": "longitude",
            "label": "Longitude",
            "type": "text",
            "required": False,
            "help": "Paired with latitude. Both must be set if you're not using zip.",
        },
        {
            "name": "units",
            "label": "Units",
            "type": "select",
            "required": False,
            "options": [
                {"value": "imperial", "label": "Imperial (°F, mph)"},
                {"value": "metric", "label": "Metric (°C, m/s)"},
                {"value": "standard", "label": "Standard (K, m/s)"},
            ],
            "default": _DEFAULT_UNITS,
            "help": "Affects ``temp``, ``feels_like``, and ``wind_speed`` units. ``visibility`` is always meters per the OpenWeatherMap API.",
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "weather_fetch",
    "json": {
        "conditions": "broken clouds",
        "temp": 54.3,
        "feels_like": 51.2,
        "humidity": 78,
        "pressure": 1015,
        "wind_speed": 8.2,
        "wind_direction": 180,
        "visibility": 10000,
        "location": "Tacoma, US",
        "units": "imperial",
    },
    "text": "broken clouds, 54.3°F (feels like 51.2°F), wind 8.2 mph",
}


def _coerce_float(v: Any) -> float | None:
    try:
        return float(str(v).strip()) if v is not None and str(v).strip() != "" else None
    except (ValueError, TypeError):
        return None


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    """``connection`` is the OpenWeatherMap connection (resolved via connection_id)."""
    if connection.type != "openweathermap":
        raise ValueError(
            f"weather_fetch needs an openweathermap connection, got {connection.type!r}"
        )

    secret = decrypt_secret(connection.encrypted_secret)
    raw_api_key = secret.get("api_key")
    if not raw_api_key:
        raise ValueError("OpenWeatherMap connection has no api_key set")
    # Strip whitespace defensively — copy-paste from the OpenWeatherMap
    # dashboard sometimes brings a trailing newline along, which makes
    # ``appid=ABC...\n`` 401 with "Invalid API key" even though the key
    # itself is fine.
    api_key = str(raw_api_key).strip()
    if not api_key:
        raise ValueError("OpenWeatherMap api_key is empty after stripping whitespace")

    # ---- Resolve location (zip wins over lat/lon when both set, since
    # operators paste a zip more often by mistake than lat/lon) ----
    zip_code = resolve_deep(config.get("zip"), ctx)
    country = (resolve_deep(config.get("country"), ctx) or "US").strip()
    lat = _coerce_float(resolve_deep(config.get("latitude"), ctx))
    lon = _coerce_float(resolve_deep(config.get("longitude"), ctx))

    units = resolve_deep(config.get("units"), ctx) or _DEFAULT_UNITS
    if not isinstance(units, str):
        units = str(units)

    params: dict[str, Any] = {"appid": api_key, "units": units}
    if isinstance(zip_code, str) and zip_code.strip():
        params["zip"] = f"{zip_code.strip()},{country}"
    elif lat is not None and lon is not None:
        params["lat"] = lat
        params["lon"] = lon
    else:
        raise ValueError(
            "weather_fetch needs either a zip code OR both latitude + longitude"
        )

    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(_OWM_BASE, params=params)
    if res.status_code >= 400:
        # OpenWeatherMap's error JSON looks like ``{"cod": 401, "message": "..."}``
        try:
            err = res.json().get("message")
        except Exception:  # noqa: BLE001 — best-effort
            err = res.text[:200]
        # Diagnostic log: redact the key but include length + first/last
        # 4 chars so the operator can confirm the right key is being
        # sent. The full URL (with appid stripped) tells them whether
        # zip vs lat/lon parsing did what they expected.
        key_fingerprint = (
            f"len={len(api_key)} starts={api_key[:4]} ends={api_key[-4:]}"
            if len(api_key) >= 8
            else f"len={len(api_key)}"
        )
        diag_params = {k: v for k, v in params.items() if k != "appid"}
        logger.warning(
            "weather_fetch: OpenWeatherMap %d - %s | sent params=%s | api_key %s",
            res.status_code,
            err,
            diag_params,
            key_fingerprint,
        )
        # 401 specifically usually means key-not-yet-active OR a paste
        # included a stray space / newline. Tell the operator both.
        if res.status_code == 401:
            raise ValueError(
                f"OpenWeatherMap rejected the API key ({err}). Two common causes: "
                "(1) the key was created in the last hour and hasn't activated yet — "
                "OpenWeatherMap can take 10 min to a few hours, just wait and retry. "
                "(2) the pasted key had a stray space / newline — "
                "open the connection, hit reveal, and verify the value looks clean. "
                f"Key fingerprint sent: {key_fingerprint}."
            )
        raise ValueError(f"OpenWeatherMap returned {res.status_code}: {err}")

    body = res.json()

    # OpenWeatherMap nests fields under main / wind / weather[0]. We
    # flatten to a single ``json`` object so Helix attribute mappings
    # like ``{{ output.json.temp }}`` are one-segment reads.
    weather_list = body.get("weather") or []
    conditions = (
        weather_list[0].get("description")
        if isinstance(weather_list, list) and weather_list and isinstance(weather_list[0], dict)
        else None
    )
    main = body.get("main") or {}
    wind = body.get("wind") or {}
    sys_block = body.get("sys") or {}
    city_name = body.get("name")
    location_label = (
        f"{city_name}, {sys_block.get('country')}"
        if city_name and sys_block.get("country")
        else city_name or sys_block.get("country") or ""
    )

    temp = main.get("temp")
    feels_like = main.get("feels_like")
    wind_speed = wind.get("speed")
    wind_dir = wind.get("deg")
    unit_temp = "°F" if units == "imperial" else ("°C" if units == "metric" else "K")
    unit_wind = "mph" if units == "imperial" else "m/s"

    summary_parts: list[str] = []
    if conditions:
        summary_parts.append(str(conditions))
    if temp is not None:
        if feels_like is not None and feels_like != temp:
            summary_parts.append(
                f"{temp}{unit_temp} (feels like {feels_like}{unit_temp})"
            )
        else:
            summary_parts.append(f"{temp}{unit_temp}")
    if wind_speed is not None:
        summary_parts.append(f"wind {wind_speed} {unit_wind}")
    text = ", ".join(summary_parts) if summary_parts else "weather data unavailable"

    return {
        "action": "weather_fetch",
        "json": {
            "conditions": conditions,
            "temp": temp,
            "feels_like": feels_like,
            "humidity": main.get("humidity"),
            "pressure": main.get("pressure"),
            "wind_speed": wind_speed,
            "wind_direction": wind_dir,
            "visibility": body.get("visibility"),
            "location": location_label,
            "units": units,
        },
        "text": text,
    }
