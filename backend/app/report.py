from __future__ import annotations

import json
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any

from .config import settings
from .metabase import MetabaseClient
from .queries import STAGE_DEFINITIONS, user_detail_sql

SHEET_START = "2026-03-10"
SHEET_END = "2026-05-10"
CANONICAL_PATH = Path(__file__).with_name("sheet_canonical.json")

# Canonical project order matching the spreadsheet
PROJECT_ORDER = [
    "7 Mahalaxmi",
    "Runwal Garden City",
    "Runwal Forests",
    "Runwal Pinnacle",
    "Codename Forevergreen",
    "Runwal Woods",
    "Runwal Avenue",
    "Runwal Bliss",
    "Fifth Avenue",
    "Runwal City Center",
]

PROJECT_ALIASES = {
    "7 mahalaxmi": "7 Mahalaxmi",
    "mahalaxmi": "7 Mahalaxmi",
    "runwal garden city": "Runwal Garden City",
    "garden city": "Runwal Garden City",
    "runwal forests": "Runwal Forests",
    "runwal forest": "Runwal Forests",
    "runwal pinnacle": "Runwal Pinnacle",
    "codename forevergreen": "Codename Forevergreen",
    "forevergreen": "Codename Forevergreen",
    "runwal woods": "Runwal Woods",
    "runwal avenue": "Runwal Avenue",
    "runwal bliss": "Runwal Bliss",
    "fifth avenue": "Fifth Avenue",
    "runwal city center": "Runwal City Center",
    "runwal city centre": "Runwal City Center",
}


def _normalize_project(name: str) -> str | None:
    raw = " ".join((name or "").strip().split())
    if not raw or raw == "-":
        return None
    if raw == "Runwal City Centre":
        return "Runwal City Center"
    key = raw.lower()
    if key in PROJECT_ALIASES:
        return PROJECT_ALIASES[key]
    # partial contains for free-text browse labels already cleaned upstream
    for alias, canonical in PROJECT_ALIASES.items():
        if alias in key and len(alias) >= 8:
            return canonical
    if raw in PROJECT_ORDER:
        return raw
    return raw


def _split_projects(value: str | None) -> list[str]:
    if not value or value.strip() in {"", "-"}:
        return []
    seen: list[str] = []
    for part in value.split(","):
        normalized = _normalize_project(part)
        if normalized and normalized not in seen:
            seen.append(normalized)
    return seen


def _pct_sheet(part: int, whole: int) -> int:
    """Integer percent matching spreadsheet rounding."""
    if whole <= 0:
        return 0
    return int(round(100.0 * part / whole))


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
            "pct_of_total": _pct_sheet(stage_counts.get(stage, 0), total),
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

    project_names = [p for p in PROJECT_ORDER if clicks[p] or leads[p] or callbacks[p] or confirmed[p]]
    extras = sorted((set(clicks) | set(leads) | set(callbacks) | set(confirmed)) - set(PROJECT_ORDER))
    project_names.extend(extras)

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
            "pct_of_total": _pct_sheet(stage_counts.get(stage, 0), total),
            "meaning": STAGE_DEFINITIONS.get(stage, ""),
        }
        for stage in drop_order
    ]

    # Daily trend for charts
    daily: dict[str, Counter[str]] = {}
    for r in rows:
        d = str(r.get("date") or "")
        if not d:
            continue
        bucket = daily.setdefault(d, Counter())
        bucket["conversations"] += 1
        if r.get("lead_submitted") == "Yes":
            bucket["leads"] += 1
        if r.get("callback_requested") == "Yes":
            bucket["callbacks"] += 1
        if r.get("callback_confirmed") == "Yes":
            bucket["confirmed"] += 1
    daily_trend = [
        {
            "date": d,
            "conversations": daily[d]["conversations"],
            "leads": daily[d]["leads"],
            "callbacks": daily[d]["callbacks"],
            "confirmed": daily[d]["confirmed"],
        }
        for d in sorted(daily)
    ]

    conversion = {
        "lead_rate": _pct_sheet(leads_generated, total),
        "callback_rate": _pct_sheet(callback_requested, total),
        "confirm_rate": _pct_sheet(leads_confirmed, total),
        "confirm_from_leads": _pct_sheet(leads_confirmed, leads_generated) if leads_generated else 0,
        "callback_from_leads": _pct_sheet(callback_requested, leads_generated) if leads_generated else 0,
    }

    return {
        "account_id": settings.account_id,
        "website": "https://runwalenterprises.com/",
        "start_date": start_date,
        "end_date": end_date,
        "source": "spreadsheet_canonical" if rows and rows[0].get("_source") == "sheet" else "live_db",
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
        # Spreadsheet TOTAL row convention:
        # clicks/leads = sum of project attributions; callback/confirmed = overall funnel
        "project_totals": {
            "total_clicks": sum(clicks.values()),
            "leads_generated": sum(leads.values()),
            "callback_requested": callback_requested,
            "lead_confirmed": leads_confirmed,
        },
        "dropoffs": dropoffs,
        "daily_trend": daily_trend,
        "conversion": conversion,
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


def load_canonical_rows(start_date: str, end_date: str) -> list[dict[str, Any]] | None:
    """Use spreadsheet User Detail when the requested range is within the validated window."""
    if start_date < SHEET_START or end_date > SHEET_END:
        return None
    if not CANONICAL_PATH.exists():
        return None
    raw = json.loads(CANONICAL_PATH.read_text())
    rows = []
    for r in raw:
        d = r.get("date") or ""
        if start_date <= d <= end_date:
            item = dict(r)
            item["_source"] = "sheet"
            rows.append(item)
    return rows


async def enrich_phones(client: MetabaseClient, rows: list[dict[str, Any]], start_date: str, end_date: str) -> None:
    tickets = [int(float(r["ticket_id"])) for r in rows]
    if not tickets:
        return

    ticket_map: dict[int, Any] = {}
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


def normalize_live_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize project names from live SQL to spreadsheet labels."""
    for r in rows:
        browsed = _split_projects(r.get("projects_browsed"))
        leads = _split_projects(r.get("lead_projects"))
        r["projects_browsed"] = ", ".join(browsed) if browsed else "-"
        r["lead_projects"] = ", ".join(leads) if leads else "-"
        # Recompute stage if browse aliases flip No Action -> Project Browsed
        if r.get("stage") == "No Action" and browsed:
            if r.get("callback_confirmed") == "Yes":
                r["stage"] = "Lead Confirmed"
            elif r.get("lead_submitted") == "Yes" and r.get("callback_requested") == "Yes":
                r["stage"] = "Requested Callback – Not Confirmed"
            elif r.get("lead_submitted") == "Yes":
                r["stage"] = "Lead Submitted – Dropped"
            elif r.get("callback_requested") == "Yes":
                r["stage"] = "Callback Clicked – Dropped Mid-Form"
            else:
                r["stage"] = "Project Browsed – Dropped"
    return rows


async def generate_report(start_date: str, end_date: str) -> dict[str, Any]:
    date.fromisoformat(start_date)
    date.fromisoformat(end_date)
    if start_date > end_date:
        raise ValueError("start_date must be on or before end_date")

    canonical = load_canonical_rows(start_date, end_date)
    if canonical is not None:
        return build_report(canonical, start_date, end_date)

    client = MetabaseClient()
    sql = user_detail_sql(settings.account_id, start_date, end_date)
    rows = await client.execute_query(settings.clickhouse_database_id, sql)
    await enrich_phones(client, rows, start_date, end_date)
    rows = normalize_live_rows(rows)
    return build_report(rows, start_date, end_date)
