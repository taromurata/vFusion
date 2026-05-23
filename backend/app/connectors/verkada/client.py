"""Minimal Verkada Command API client.

Two-step auth: ``POST /token`` with the long-lived ``x-api-key`` exchanges
it for a short-lived session token, which is then sent as
``x-verkada-auth`` on subsequent calls. The client caches the token in
memory for its lifetime; if it expires, recreate the client.
"""

from typing import Any

import httpx


DEFAULT_BASE_URL = "https://api.verkada.com"


class VerkadaApiError(Exception):
    pass


class VerkadaClient:
    def __init__(self, api_key: str, base_url: str | None = None, timeout: float = 15.0):
        self.api_key = api_key
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self._token: str | None = None

    # ---- auth ----

    async def login(self) -> str:
        """Exchange the API key for a short-lived session token."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.post(
                f"{self.base_url}/token",
                headers={"x-api-key": self.api_key, "accept": "application/json"},
            )
        if res.status_code >= 400:
            raise VerkadaApiError(
                f"login failed: status={res.status_code} body={res.text!r}"
            )
        body = res.json()
        token = body.get("token")
        if not isinstance(token, str) or not token:
            raise VerkadaApiError(f"login returned no token: {body!r}")
        self._token = token
        return token

    async def _ensure_token(self) -> str:
        if self._token is None:
            await self.login()
        assert self._token is not None
        return self._token

    # ---- HTTP helpers ----

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        token = await self._ensure_token()
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.get(
                f"{self.base_url}{path}",
                headers={"x-verkada-auth": token, "accept": "application/json"},
                params=params,
            )
        if res.status_code >= 400:
            raise VerkadaApiError(
                f"GET {path} failed: status={res.status_code} body={res.text!r}"
            )
        try:
            return res.json()
        except ValueError:
            return res.text

    async def _post(self, path: str, json: dict[str, Any]) -> dict[str, Any]:
        return await self.request("POST", path, json_body=json)

    async def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        json_body: Any = None,
    ) -> dict[str, Any]:
        """Generic authed call. Use this for any Verkada endpoint.

        Returns ``{"status_code": int, "body": <parsed json or text>}``
        regardless of success — caller checks ``status_code``.
        """
        token = await self._ensure_token()
        headers = {"x-verkada-auth": token, "accept": "application/json"}
        if json_body is not None:
            headers["content-type"] = "application/json"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.request(
                method.upper(),
                f"{self.base_url}{path}",
                headers=headers,
                params=query,
                json=json_body if json_body is not None else None,
            )
        body: Any
        try:
            body = res.json()
        except ValueError:
            body = res.text
        return {"status_code": res.status_code, "body": body}

    # ---- endpoints ----

    async def list_cameras(self) -> list[dict[str, Any]]:
        """Return the full list of cameras for this org.

        Endpoint: ``GET /cameras/v1/devices``. Response shape:
        ``{"cameras": [{...}, ...]}``.
        """
        data = await self._get("/cameras/v1/devices")
        if isinstance(data, dict) and isinstance(data.get("cameras"), list):
            return data["cameras"]
        if isinstance(data, list):
            return data
        raise VerkadaApiError(f"unexpected list_cameras response shape: {type(data).__name__}")

    async def list_doors(self) -> list[dict[str, Any]]:
        """Return the full list of doors for this org.

        Endpoint: ``GET /access/v1/doors``. Response shape:
        ``{"doors": [{...}, ...]}`` — Verkada returns wrapped lists.
        """
        data = await self._get("/access/v1/doors")
        if isinstance(data, dict) and isinstance(data.get("doors"), list):
            return data["doors"]
        if isinstance(data, list):
            return data
        raise VerkadaApiError(f"unexpected list_doors response shape: {type(data).__name__}")

    async def list_scenarios(self) -> list[dict[str, Any]]:
        """Return the full list of Access scenarios for this org.

        Endpoint: ``GET /access/v1/scenarios``. The endpoint docs list
        ``scenario_ids``, ``site_ids``, ``types``, ``scenario_types`` as
        optional query params — none of which we pass; we want every
        scenario configured in Command. Response is expected to be a
        wrapped list (``{"scenarios": [...]}``); we tolerate a bare list
        too in case the shape ever changes.
        """
        data = await self._get("/access/v1/scenarios")
        if isinstance(data, dict):
            for key in ("scenarios", "items", "data"):
                if isinstance(data.get(key), list):
                    return data[key]
        if isinstance(data, list):
            return data
        raise VerkadaApiError(
            f"unexpected list_scenarios response shape: {type(data).__name__}"
        )

    async def list_helix_event_types(self) -> list[dict[str, Any]]:
        """Return all Helix video-tagging event types defined in this org.

        Endpoint: ``GET /cameras/v1/video_tagging/event_type`` (singular).
        Response shape: ``{"event_types": [{event_type_uid, name, event_schema, org_id}, ...]}``.
        """
        data = await self._get("/cameras/v1/video_tagging/event_type")
        if isinstance(data, dict) and isinstance(data.get("event_types"), list):
            return data["event_types"]
        if isinstance(data, list):
            return data
        raise VerkadaApiError(
            f"unexpected list_helix_event_types response shape: {type(data).__name__}"
        )

    async def create_helix_event_type(
        self, name: str, event_schema: dict[str, Any]
    ) -> dict[str, Any]:
        """Create a new Helix video-tagging event type.

        Endpoint: ``POST /cameras/v1/video_tagging/event_type``.
        Body: ``{"name": str, "event_schema": {attr: type, ...}}``.
        Returns the newly-created event type body — Verkada includes the
        assigned ``event_type_uid`` in the response.
        """
        result = await self.request(
            "POST",
            "/cameras/v1/video_tagging/event_type",
            json_body={"name": name, "event_schema": event_schema},
        )
        if result["status_code"] >= 400:
            raise VerkadaApiError(
                f"create_helix_event_type failed: status={result['status_code']} body={result['body']!r}"
            )
        body = result["body"]
        if not isinstance(body, dict):
            raise VerkadaApiError(
                f"unexpected create_helix_event_type response shape: {type(body).__name__}"
            )
        return body

    async def update_helix_event_type(
        self,
        event_type_uid: str,
        *,
        name: str | None = None,
        event_schema: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Update an existing Helix event type's name and/or schema.

        Endpoint: ``PATCH /cameras/v1/video_tagging/event_type?event_type_uid=...``.
        Body fields are both optional — pass only what you want changed.
        """
        patch_body: dict[str, Any] = {}
        if name is not None:
            patch_body["name"] = name
        if event_schema is not None:
            patch_body["event_schema"] = event_schema
        if not patch_body:
            raise ValueError("update_helix_event_type called with no fields to change")
        result = await self.request(
            "PATCH",
            "/cameras/v1/video_tagging/event_type",
            query={"event_type_uid": event_type_uid},
            json_body=patch_body,
        )
        if result["status_code"] >= 400:
            raise VerkadaApiError(
                f"update_helix_event_type failed: status={result['status_code']} body={result['body']!r}"
            )
        body = result["body"]
        if not isinstance(body, dict):
            raise VerkadaApiError(
                f"unexpected update_helix_event_type response shape: {type(body).__name__}"
            )
        return body

    async def unlock_door(self, door_id: str) -> dict[str, Any]:
        result = await self._post("/access/v1/door/admin_unlock", {"door_id": door_id})
        if result["status_code"] >= 400:
            raise VerkadaApiError(
                f"unlock_door failed: status={result['status_code']} body={result['body']!r}"
            )
        return result
