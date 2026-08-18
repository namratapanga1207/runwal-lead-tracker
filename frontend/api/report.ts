import type { VercelRequest, VercelResponse } from "@vercel/node";
import { executeMetabaseQuery } from "./metabase.js";
import {
  PROJECT_ALIASES,
  PROJECT_ORDER,
  STAGE_DEFINITIONS,
  userDetailSql,
} from "./queries.js";
import { SHEET_CANONICAL, type UserRow } from "./sheet_canonical.js";

const ACCOUNT_ID = Number(process.env.ACCOUNT_ID || 28982);
const CLICKHOUSE_DATABASE_ID = Number(process.env.CLICKHOUSE_DATABASE_ID || 82);
const HDT_DATABASE_ID = Number(process.env.HDT_DATABASE_ID || 72);
const SHEET_START = "2026-03-10";
const SHEET_END = "2026-05-10";

function normalizeProject(name: string): string | null {
  const raw = name.trim().replace(/\s+/g, " ");
  if (!raw || raw === "-") return null;
  if (raw === "Runwal City Centre") return "Runwal City Center";
  const key = raw.toLowerCase();
  if (PROJECT_ALIASES[key]) return PROJECT_ALIASES[key];
  for (const [alias, canonical] of Object.entries(PROJECT_ALIASES)) {
    if (alias.length >= 8 && key.includes(alias)) return canonical;
  }
  if (PROJECT_ORDER.includes(raw)) return raw;
  return raw;
}

function splitProjects(value?: string) {
  if (!value || value.trim() === "" || value.trim() === "-") return [] as string[];
  const seen: string[] = [];
  for (const part of value.split(",")) {
    const p = normalizeProject(part);
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

function pctSheet(part: number, whole: number) {
  return whole <= 0 ? 0 : Math.round((100 * part) / whole);
}

function normalizeLiveRows(rows: UserRow[]): UserRow[] {
  return rows.map((r) => {
    const browsed = splitProjects(r.projects_browsed);
    const leads = splitProjects(r.lead_projects);
    const next: UserRow = {
      ...r,
      projects_browsed: browsed.length ? browsed.join(", ") : "-",
      lead_projects: leads.length ? leads.join(", ") : "-",
    };
    if (next.stage === "No Action" && browsed.length) {
      if (next.callback_confirmed === "Yes") next.stage = "Lead Confirmed";
      else if (next.lead_submitted === "Yes" && next.callback_requested === "Yes") {
        next.stage = "Requested Callback – Not Confirmed";
      } else if (next.lead_submitted === "Yes") next.stage = "Lead Submitted – Dropped";
      else if (next.callback_requested === "Yes") next.stage = "Callback Clicked – Dropped Mid-Form";
      else next.stage = "Project Browsed – Dropped";
    }
    return next;
  });
}

async function enrichPhones(rows: UserRow[]) {
  const tickets = rows.map((r) => Number(r.ticket_id)).filter((n) => n > 0);
  if (!tickets.length) return;

  const ticketMap = new Map<number, { phone_number?: string; name?: string }>();
  for (let i = 0; i < tickets.length; i += 80) {
    const chunk = tickets.slice(i, i + 80);
    const ids = chunk.join(", ");
    const sql = `
      SELECT DISTINCT ON (c.display_id)
        c.display_id AS ticket_id,
        ct.phone_number,
        ct.name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = ${ACCOUNT_ID}
      WHERE c.account_id = ${ACCOUNT_ID}
        AND c.display_id IN (${ids})
      ORDER BY c.display_id, c.updated_at DESC
    `;
    try {
      const data = await executeMetabaseQuery(HDT_DATABASE_ID, sql);
      for (const row of data) {
        ticketMap.set(Number(row.ticket_id), {
          phone_number: row.phone_number != null ? String(row.phone_number) : undefined,
          name: row.name != null ? String(row.name) : undefined,
        });
      }
    } catch {
      return;
    }
  }

  for (const r of rows) {
    const contact = ticketMap.get(Number(r.ticket_id));
    if (!contact) continue;
    if (!String(r.phone_number || "").trim() && contact.phone_number) {
      r.phone_number = contact.phone_number;
    }
    if (!String(r.name || "").trim() && contact.name) {
      r.name = contact.name;
    }
  }
}

function mapMetabaseRows(raw: Array<Record<string, unknown>>): UserRow[] {
  return raw.map((r) => ({
    ticket_id: Number(r.ticket_id || 0),
    date: String(r.date || ""),
    name: String(r.name || ""),
    phone_number: String(r.phone_number || ""),
    projects_browsed: String(r.projects_browsed || "-"),
    lead_projects: String(r.lead_projects || "-"),
    lead_submitted: String(r.lead_submitted || "No"),
    callback_requested: String(r.callback_requested || "No"),
    callback_confirmed: String(r.callback_confirmed || "No"),
    stage: String(r.stage || "No Action"),
  }));
}

function buildReport(rows: UserRow[], startDate: string, endDate: string, source: string) {
  const total = rows.length;
  const stageCounts = new Map<string, number>();
  for (const r of rows) {
    const stage = r.stage || "No Action";
    stageCounts.set(stage, (stageCounts.get(stage) || 0) + 1);
  }

  const phones = new Set<string>();
  for (const r of rows) {
    const phone = String(r.phone_number || "").trim();
    if (!phone) continue;
    const digits = phone.replace(/\D/g, "");
    phones.add(digits || phone);
  }

  const stageOrder = [
    "Lead Confirmed",
    "Requested Callback – Not Confirmed",
    "Lead Submitted – Dropped",
    "Callback Clicked – Dropped Mid-Form",
    "Project Browsed – Dropped",
    "No Action",
  ];

  const clicks = new Map<string, number>();
  const leads = new Map<string, number>();
  const callbacks = new Map<string, number>();
  const confirmed = new Map<string, number>();
  const dropForm = new Map<string, number>();
  const dropProj = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);

  for (const r of rows) {
    const browsed = splitProjects(r.projects_browsed);
    const leadProjects = splitProjects(r.lead_projects);
    browsed.forEach((p) => bump(clicks, p));
    if (r.lead_submitted === "Yes") {
      leadProjects.forEach((p) => {
        bump(leads, p);
        if (r.callback_confirmed !== "Yes") bump(dropForm, p);
      });
    }
    if (r.callback_requested === "Yes") leadProjects.forEach((p) => bump(callbacks, p));
    if (r.callback_confirmed === "Yes") leadProjects.forEach((p) => bump(confirmed, p));
    if (r.stage === "Project Browsed – Dropped") browsed.forEach((p) => bump(dropProj, p));
  }

  const projectNames = [
    ...PROJECT_ORDER.filter((p) => clicks.get(p) || leads.get(p) || callbacks.get(p) || confirmed.get(p)),
    ...[...new Set([...clicks.keys(), ...leads.keys(), ...callbacks.keys(), ...confirmed.keys()])]
      .filter((p) => !PROJECT_ORDER.includes(p))
      .sort(),
  ];

  const projects = projectNames.map((p) => {
    const leadCount = leads.get(p) || 0;
    const confCount = confirmed.get(p) || 0;
    return {
      project: p,
      total_clicks: clicks.get(p) || 0,
      leads_generated: leadCount,
      callback_requested: callbacks.get(p) || 0,
      lead_confirmed: confCount,
      dropped_after_form_submit: dropForm.get(p) || 0,
      dropped_after_project_click: dropProj.get(p) || 0,
      lead_confirm_rate: leadCount ? Math.round((100 * confCount) / leadCount) : null,
    };
  });

  const leadsGenerated = rows.filter((r) => r.lead_submitted === "Yes").length;
  const callbackRequested = rows.filter((r) => r.callback_requested === "Yes").length;
  const leadsConfirmed = rows.filter((r) => r.callback_confirmed === "Yes").length;

  const dropOrder = [
    "Lead Submitted – Dropped",
    "Requested Callback – Not Confirmed",
    "Callback Clicked – Dropped Mid-Form",
    "Project Browsed – Dropped",
    "No Action",
  ];

  const dailyMap = new Map<string, { conversations: number; leads: number; callbacks: number; confirmed: number }>();
  for (const r of rows) {
    const d = r.date;
    if (!d) continue;
    const bucket = dailyMap.get(d) || { conversations: 0, leads: 0, callbacks: 0, confirmed: 0 };
    bucket.conversations += 1;
    if (r.lead_submitted === "Yes") bucket.leads += 1;
    if (r.callback_requested === "Yes") bucket.callbacks += 1;
    if (r.callback_confirmed === "Yes") bucket.confirmed += 1;
    dailyMap.set(d, bucket);
  }

  return {
    account_id: ACCOUNT_ID,
    website: "https://runwalenterprises.com/",
    start_date: startDate,
    end_date: endDate,
    source,
    funnel: {
      total_conversations: total,
      unique_phone_numbers: phones.size,
      leads_generated: leadsGenerated,
      callback_requested: callbackRequested,
      leads_confirmed: leadsConfirmed,
      no_action: stageCounts.get("No Action") || 0,
    },
    stages: stageOrder.map((stage) => ({
      stage,
      users: stageCounts.get(stage) || 0,
      pct_of_total: pctSheet(stageCounts.get(stage) || 0, total),
      meaning: STAGE_DEFINITIONS[stage],
    })),
    projects,
    project_totals: {
      total_clicks: [...clicks.values()].reduce((a, b) => a + b, 0),
      leads_generated: [...leads.values()].reduce((a, b) => a + b, 0),
      callback_requested: callbackRequested,
      lead_confirmed: leadsConfirmed,
    },
    dropoffs: dropOrder.map((stage) => ({
      stage,
      users: stageCounts.get(stage) || 0,
      pct_of_total: pctSheet(stageCounts.get(stage) || 0, total),
      meaning: STAGE_DEFINITIONS[stage],
    })),
    daily_trend: [...dailyMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, ...v })),
    conversion: {
      lead_rate: pctSheet(leadsGenerated, total),
      callback_rate: pctSheet(callbackRequested, total),
      confirm_rate: pctSheet(leadsConfirmed, total),
      confirm_from_leads: leadsGenerated ? pctSheet(leadsConfirmed, leadsGenerated) : 0,
      callback_from_leads: leadsGenerated ? pctSheet(callbackRequested, leadsGenerated) : 0,
    },
    users: rows,
  };
}

async function loadLiveReport(startDate: string, endDate: string) {
  const sql = userDetailSql(ACCOUNT_ID, startDate, endDate);
  const raw = await executeMetabaseQuery(CLICKHOUSE_DATABASE_ID, sql);
  let rows = mapMetabaseRows(raw);
  await enrichPhones(rows);
  rows = normalizeLiveRows(rows);
  return buildReport(rows, startDate, endDate, "live_db");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-password");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ detail: "Method not allowed" });

  const expectedPassword = process.env.DASHBOARD_PASSWORD || "L!M3CH@T4767";
  const provided = String(req.headers["x-dashboard-password"] || "");
  if (provided !== expectedPassword) {
    return res.status(401).json({ detail: "Unauthorized" });
  }

  const startDate = String(req.query.start_date || "");
  const endDate = String(req.query.end_date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ detail: "start_date and end_date are required as YYYY-MM-DD" });
  }
  if (startDate > endDate) {
    return res.status(400).json({ detail: "start_date must be on or before end_date" });
  }

  try {
    // Validated spreadsheet window keeps exact sheet numbers; all other ranges use live DB logic
    if (startDate >= SHEET_START && endDate <= SHEET_END) {
      const rows = SHEET_CANONICAL.filter((r) => r.date >= startDate && r.date <= endDate);
      return res.status(200).json(buildReport(rows, startDate, endDate, "spreadsheet_canonical"));
    }

    const report = await loadLiveReport(startDate, endDate);
    return res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ detail: message });
  }
}
