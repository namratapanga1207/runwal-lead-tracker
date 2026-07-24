from __future__ import annotations

from collections import Counter
from datetime import date
from typing import Any

from .config import settings
from .metabase import MetabaseClient
from .queries import STAGE_DEFINITIONS, user_detail_sql


def _split_projects(value: str | None) -> list[str]:
    if not value or value.strip() in {"", "-"}:
        return []
    parts = [p.strip() for p in value.split(",")]
    # normalize Centre -> Center for rollups
    normalized = []
    for p in parts:
        if not p or p == "-":
            continue
        if p == "Runwal City Centre":
            p = "Runwal City Center"
        normalized.append(p)
    return normalized


def _pct(part: int, whole: int) -> float:
    if whole <= 0:
        return 0.0
    return round(100.0 * part / whole, 1)


def build_report(rows: list[dict[str, Any]], start_date: str, end_date: str) -> dict[str, Any]:
    total = len(rows)
    stage_counts = Counter(r.get("stage") or "No Action" for r in rows)

    leads_generated = sum(1 for r in rows if r.get("lead_submitted") == "Yes")
    callback_requested = sum(1 for r in rows if r.get("callback_requested") == "Yes")
    leads_confirmed = sum(1 for r in rows if r.get("callback_confirmed") == "Yes")

    phones = set()
    for r in rows:
        phone = str(r.get("phone_number") or "").strip()
        if not phone:
            continue
        digits = "".join(ch for ch in phone if ch.isdigit())
        phones.add(digits if digits else phone)

    stage_order = [
        "Lead Confirmed",
        "Requested Callback – Not Confirmed",
        "Lead Submitted – Dropped",
        "Callback Clicked – Dropped Mid-Form",
        "Project Browsed – Dropped",
        "No Action",
    ]
    stages = [
        {
            "stage": stage,
            "users": stage_counts.get(stage, 0),
            "pct_of_total": _pct(stage_counts.get(stage, 0), total),
            "meaning": STAGE_DEFINITIONS.get(stage, ""),
        }
        for stage in stage_order
    ]

    clicks: Counter[str] = Counter()
    leads: Counter[str] = Counter()
    callbacks: Counter[str] = Counter()
    confirmed: Counter[str] = Counter()
    drop_after_form: Counter[str] = Counter()
    drop_after_project: Counter[str] = Counter()

    for r in rows:
        browsed = _split_projects(r.get("projects_browsed"))
        lead_projects = _split_projects(r.get("lead_projects"))
        for p in browsed:
            clicks[p] += 1
        if r.get("lead_submitted") == "Yes":
            for p in lead_projects:
                leads[p] += 1
                if r.get("callback_confirmed") != "Yes":
                    drop_after_form[p] += 1
        if r.get("callback_requested") == "Yes":
            for p in lead_projects:
                callbacks[p] += 1
        if r.get("callback_confirmed") == "Yes":
            for p in lead_projects:
                confirmed[p] += 1
        if r.get("stage") == "Project Browsed – Dropped":
            for p in browsed:
                drop_after_project[p] += 1

    project_names = sorted(set(clicks) | set(leads) | set(callbacks) | set(confirmed), key=lambda p: (-clicks[p], p))
    projects = []
    for p in project_names:
        lead_count = leads[p]
        conf_count = confirmed[p]
        projects.append(
            {
                "project": p,
                "total_clicks": clicks[p],
                "leads_generated": lead_count,
                "callback_requested": callbacks[p],
                "lead_confirmed": conf_count,
                "dropped_after_form_submit": drop_after_form[p],
                "dropped_after_project_click": drop_after_project[p],
                "lead_confirm_rate": round(100.0 * conf_count / lead_count) if lead_count else None,
            }
        )

    drop_order = [
        "Lead Submitted – Dropped",
        "Requested Callback – Not Confirmed",
        "Callback Clicked – Dropped Mid-Form",
        "Project Browsed – Dropped",
        "No Action",
    ]
    dropoffs = [
        {
            "stage": stage,
            "users": stage_counts.get(stage, 0),
            "pct_of_total": _pct(stage_counts.get(stage, 0), total),
            "meaning": STAGE_DEFINITIONS.get(stage, ""),
        }
        for stage in drop_order
    ]

    return {
        "account_id": settings.account_id,
        "website": "https://runwalenterprises.com/",
        "start_date": start_date,
        "end_date": end_date,
        "funnel": {
            "total_conversations": total,
            "unique_phone_numbers": len(phones),
            "leads_generated": leads_generated,
            "callback_requested": callback_requested,
            "leads_confirmed": leads_confirmed,
            "no_action": stage_counts.get("No Action", 0),
        },
        "stages": stages,
        "projects": projects,
        "project_totals": {
            "total_clicks": sum(clicks.values()),
            "leads_generated": sum(leads.values()),
            "callback_requested": sum(callbacks.values()),
            "lead_confirmed": sum(confirmed.values()),
        },
        "dropoffs": dropoffs,
        "users": [
            {
                "ticket_id": int(float(r.get("ticket_id") or 0)),
                "date": r.get("date"),
                "name": r.get("name") or "",
                "phone_number": r.get("phone_number") or "",
                "projects_browsed": r.get("projects_browsed") or "-",
                "lead_projects": r.get("lead_projects") or "-",
                "lead_submitted": r.get("lead_submitted"),
                "callback_requested": r.get("callback_requested"),
                "callback_confirmed": r.get("callback_confirmed"),
                "stage": r.get("stage"),
            }
            for r in rows
        ],
    }


async def enrich_phones(client: MetabaseClient, rows: list[dict[str, Any]], start_date: str, end_date: str) -> None:
    """Fill phones from contacts via HDT postgres (account-scoped)."""
    tickets = [int(float(r["ticket_id"])) for r in rows]
    if not tickets:
        return

    ticket_map: dict[int, str] = {}
    for i in range(0, len(tickets), 80):
        chunk = tickets[i : i + 80]
        ids = ", ".join(str(t) for t in chunk)
        sql = f"""
        SELECT DISTINCT ON (c.display_id)
          c.display_id AS ticket_id,
          ct.phone_number,
          ct.name
        FROM conversations c
        JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = {settings.account_id}
        WHERE c.account_id = {settings.account_id}
          AND c.display_id IN ({ids})
        ORDER BY c.display_id, c.updated_at DESC
        """
        try:
            data = await client.execute_query(72, sql)
            for row in data:
                ticket_map[int(float(row["ticket_id"]))] = row
        except Exception:
            return

    for r in rows:
        tid = int(float(r.get("ticket_id") or 0))
        contact = ticket_map.get(tid)
        if not contact:
            continue
        if not str(r.get("phone_number") or "").strip() and contact.get("phone_number"):
            r["phone_number"] = str(contact["phone_number"])
        if not str(r.get("name") or "").strip() and contact.get("name"):
            r["name"] = str(contact["name"])


async def generate_report(start_date: str, end_date: str) -> dict[str, Any]:
    # basic validation
    date.fromisoformat(start_date)
    date.fromisoformat(end_date)
    if start_date > end_date:
        raise ValueError("start_date must be on or before end_date")

    client = MetabaseClient()
    sql = user_detail_sql(settings.account_id, start_date, end_date)
    rows = await client.execute_query(settings.clickhouse_database_id, sql)
    await enrich_phones(client, rows, start_date, end_date)
    return build_report(rows, start_date, end_date)
