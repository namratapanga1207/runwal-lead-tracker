import type { VercelRequest, VercelResponse } from "@vercel/node";
import canonical from "./sheet_canonical.json";

const ACCOUNT_ID = Number(process.env.ACCOUNT_ID || 28982);
const SHEET_START = "2026-03-10";
const SHEET_END = "2026-05-10";

const PROJECT_ORDER = [
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
];

const STAGE_DEFINITIONS: Record<string, string> = {
  "Lead Confirmed": "Form submitted + system confirmed callback registration — fully qualified lead",
  "Requested Callback – Not Confirmed": "Filled form + clicked callback button, but system confirmation not triggered",
  "Lead Submitted – Dropped": "Form submitted (gave name/number/budget/config) but never clicked callback button",
  "Callback Clicked – Dropped Mid-Form": 'Clicked "Request A Call Back" but dropped before completing form details',
  "Project Browsed – Dropped": "Selected a project but took no further action — no callback, no form",
  "No Action": "No project interaction — job seekers, vendors, existing buyers, off-topic",
};

type UserRow = {
  ticket_id: number;
  date: string;
  name: string;
  phone_number: string;
  projects_browsed: string;
  lead_projects: string;
  lead_submitted: string;
  callback_requested: string;
  callback_confirmed: string;
  stage: string;
};

function splitProjects(value?: string) {
  if (!value || value.trim() === "" || value.trim() === "-") return [] as string[];
  const seen: string[] = [];
  for (const part of value.split(",")) {
    let p = part.trim();
    if (!p || p === "-") continue;
    if (p === "Runwal City Centre") p = "Runwal City Center";
    if (!seen.includes(p)) seen.push(p);
  }
  return seen;
}

function pctSheet(part: number, whole: number) {
  return whole <= 0 ? 0 : Math.round((100 * part) / whole);
}

function buildReport(rows: UserRow[], startDate: string, endDate: string) {
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
    source: "spreadsheet_canonical",
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ detail: "Method not allowed" });

  const startDate = String(req.query.start_date || "");
  const endDate = String(req.query.end_date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ detail: "start_date and end_date are required as YYYY-MM-DD" });
  }
  if (startDate > endDate) {
    return res.status(400).json({ detail: "start_date must be on or before end_date" });
  }

  // Spreadsheet-backed exact match for the validated window
  if (startDate >= SHEET_START && endDate <= SHEET_END) {
    const rows = (canonical as UserRow[]).filter((r) => r.date >= startDate && r.date <= endDate);
    return res.status(200).json(buildReport(rows, startDate, endDate));
  }

  return res.status(400).json({
    detail:
      "For exact spreadsheet-matching numbers, use dates within 2026-03-10 to 2026-05-10. Outside that window, use the FastAPI backend.",
  });
}
