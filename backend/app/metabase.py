from __future__ import annotations

import httpx

from .config import settings


class MetabaseClient:
    def __init__(self) -> None:
        self.base_url = settings.metabase_url.rstrip("/")
        self.api_key = settings.metabase_api_key
        if not self.api_key:
            raise RuntimeError("METABASE_API_KEY is required")

    def _headers(self) -> dict[str, str]:
        return {
            "X-API-KEY": self.api_key,
            "Content-Type": "application/json",
        }

    async def execute_query(self, database_id: int, sql: str) -> list[dict]:
        payload = {
            "database": database_id,
            "type": "native",
            "native": {"query": sql},
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{self.base_url}/api/dataset",
                headers=self._headers(),
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

        if data.get("status") == "failed":
            raise RuntimeError(data.get("error") or "Metabase query failed")

        cols = [c["name"] for c in data.get("data", {}).get("cols", [])]
        rows = data.get("data", {}).get("rows", [])
        return [dict(zip(cols, row)) for row in rows]