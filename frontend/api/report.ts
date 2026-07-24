import type { VercelRequest, VercelResponse } from "@vercel/node";

const METABASE_URL = (process.env.METABASE_URL || "https://metabase.limechat.ai").replace(/\/$/, "");
const METABASE_API_KEY = process.env.METABASE_API_KEY || "";
const ACCOUNT_ID = Number(process.env.ACCOUNT_ID || 28982);
const CLICKHOUSE_DATABASE_ID = Number(process.env.CLICKHOUSE_DATABASE_ID || 82);

const PROJECTS = [
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
  "Runwal City Centre",
];

const STAGE_DEFINITIONS: Record<string, string> = {
  "Lead Confirmed": "Form submitted + system confirmed callback registration — fully qualified lead",
  "Requested Callback – Not Confirmed": "Filled form + clicked callback button, but system confirmation not triggered",
  "Lead Submitted – Dropped": "Form submitted (gave name/number/budget/config) but never clicked callback button",
  "Callback Clicked – Dropped Mid-Form": 'Clicked "Request A Call Back" but dropped before completing form details',
  "Project Browsed – Dropped": "Selected a project but took no further action — no callback, no form",
  "No Action": "No project interaction — job seekers, vendors, existing buyers, off-topic",
};

function userDetailSql(startDate: string, endDate: string) {
  const projectList = PROJECTS.map((p) => `'${p}'`).join(", ");
  return `
WITH
params AS (
  SELECT
    toDateTime('${startDate} 00:00:00') AS start_ts,
    toDateTime(addDays(toDate('${endDate}'), 1)) AS end_ts
),
convs AS (
  SELECT
    id,
    display_id,
    contact_id,
    created_at,
    row_number() OVER (PARTITION BY display_id ORDER BY updated_at DESC, id DESC) AS rn
  FROM datawarehouse.postgres_conv_conversations
  WHERE account_id = ${ACCOUNT_ID}
    AND created_at >= (SELECT start_ts FROM params)
    AND created_at < (SELECT end_ts FROM params)
),
uniq_convs AS (
  SELECT id, display_id, contact_id, created_at
  FROM convs
  WHERE rn = 1
),
msgs AS (
  SELECT
    m.conversation_id,
    m.message_type,
    m.content
  FROM datawarehouse.postgres_hd_messages m
  INNER JOIN uniq_convs c ON c.id = m.conversation_id
  WHERE m.account_id = ${ACCOUNT_ID}
),
flags AS (
  SELECT
    conversation_id,
    max(if(message_type = 0 AND content IN (${projectList}), 1, 0)) AS project_browsed,
    max(if(message_type = 0 AND lowerUTF8(content) = 'request a call back', 1, 0)) AS callback_requested,
    max(if(message_type = 1 AND positionCaseInsensitive(content, 'successfully registered') > 0, 1, 0)) AS callback_confirmed,
    max(if(message_type = 1 AND position(content, 'Interested project:') > 0, 1, 0)) AS lead_submitted,
    arrayStringConcat(
      arrayDistinct(groupArrayIf(content, message_type = 0 AND content IN (${projectList}))),
      ', '
    ) AS projects_browsed,
    nullIf(trim(BOTH ' \\n\\r' FROM extract(
      anyIf(content, message_type = 1 AND position(content, 'Interested project:') > 0),
      'Interested project:\\\\s*([^\\\\n\\\\r*]+)'
    )), '') AS lead_projects,
    nullIf(trim(BOTH ' \\n\\r' FROM extract(
      anyIf(content, message_type = 1 AND position(content, 'Name:') > 0),
      'Name:\\\\s*([^\\\\n\\\\r*]+)'
    )), '') AS form_name,
    nullIf(trim(BOTH ' \\n\\r' FROM extract(
      anyIf(content, message_type = 1 AND position(content, 'Mobile No:') > 0),
      'Mobile No:\\\\s*([^\\\\n\\\\r*]+)'
    )), '') AS form_phone
  FROM msgs
  GROUP BY conversation_id
)
SELECT
  c.display_id AS ticket_id,
  formatDateTime(c.created_at, '%Y-%m-%d') AS date,
  coalesce(nullIf(f.form_name, ''), '') AS name,
  coalesce(nullIf(f.form_phone, ''), '') AS phone_number,
  coalesce(nullIf(f.projects_browsed, ''), '-') AS projects_browsed,
  coalesce(nullIf(f.lead_projects, ''), '-') AS lead_projects,
  if(coalesce(f.lead_submitted, 0) = 1, 'Yes', 'No') AS lead_submitted,
  if(coalesce(f.callback_requested, 0) = 1, 'Yes', 'No') AS callback_requested,
  if(coalesce(f.callback_confirmed, 0) = 1, 'Yes', 'No') AS callback_confirmed,
  multiIf(
    coalesce(f.callback_confirmed, 0) = 1, 'Lead Confirmed',
    coalesce(f.lead_submitted, 0) = 1 AND coalesce(f.callback_requested, 0) = 1, 'Requested Callback – Not Confirmed',
    coalesce(f.lead_submitted, 0) = 1 AND coalesce(f.callback_requested, 0) = 0, 'Lead Submitted – Dropped',
    coalesce(f.callback_requested, 0) = 1 AND coalesce(f.lead_submitted, 0) = 0, 'Callback Clicked – Dropped Mid-Form',
    coalesce(f.project_browsed, 0) = 1, 'Project Browsed – Dropped',
    'No Action'
  ) AS stage
FROM uniq_convs c
LEFT JOIN flags f ON c.id = f.conversation_id
ORDER BY c.display_id
`;
}

async function executeQuery(databaseId: number, sql: string) {
  const response = await fetch(`${METABASE_URL}/api/dataset`, {
    method: "POST",
    headers: {
      "X-API-KEY": METABASE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      database: databaseId,
      type: "native",
      native: { query: sql },
    }),
  });
  const data = await response.json();
  if (!response.ok || data.status === "failed") {
    throw new Error(data.error || `Metabase query failed (${response.status})`);
  }
  const cols = (data.data?.cols || []).map((c: { name: string }) => c.name);
  return (data.data?.rows || []).map((row: unknown[]) =>
    Object.fromEntries(cols.map((name: string, i: number) => [name, row[i]])),
  );
}

function splitProjects(value?: string) {
  if (!value || value.trim() === "" || value.trim() === "-") return [] as string[];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && p !== "-")
    .map((p) => (p === "Runwal City Centre" ? "Runwal City Center" : p));
}

function pct(part: number, whole: number) {
  return whole <= 0 ? 0 : Math.round((1000 * part) / whole) / 10;
}

function buildReport(rows: Record<string, string>[], startDate: string, endDate: string) {
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

  const projectNames = [...new Set([...clicks.keys(), ...leads.keys(), ...callbacks.keys(), ...confirmed.keys()])].sort(
    (a, b) => (clicks.get(b) || 0) - (clicks.get(a) || 0) || a.localeCompare(b),
  );

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

  const dropOrder = [
    "Lead Submitted – Dropped",
    "Requested Callback – Not Confirmed",
    "Callback Clicked – Dropped Mid-Form",
    "Project Browsed – Dropped",
    "No Action",
  ];

  return {
    account_id: ACCOUNT_ID,
    website: "https://runwalenterprises.com/",
    start_date: startDate,
    end_date: endDate,
    funnel: {
      total_conversations: total,
      unique_phone_numbers: phones.size,
      leads_generated: rows.filter((r) => r.lead_submitted === "Yes").length,
      callback_requested: rows.filter((r) => r.callback_requested === "Yes").length,
      leads_confirmed: rows.filter((r) => r.callback_confirmed === "Yes").length,
      no_action: stageCounts.get("No Action") || 0,
    },
    stages: stageOrder.map((stage) => ({
      stage,
      users: stageCounts.get(stage) || 0,
      pct_of_total: pct(stageCounts.get(stage) || 0, total),
      meaning: STAGE_DEFINITIONS[stage],
    })),
    projects,
    project_totals: {
      total_clicks: [...clicks.values()].reduce((a, b) => a + b, 0),
      leads_generated: [...leads.values()].reduce((a, b) => a + b, 0),
      callback_requested: [...callbacks.values()].reduce((a, b) => a + b, 0),
      lead_confirmed: [...confirmed.values()].reduce((a, b) => a + b, 0),
    },
    dropoffs: dropOrder.map((stage) => ({
      stage,
      users: stageCounts.get(stage) || 0,
      pct_of_total: pct(stageCounts.get(stage) || 0, total),
      meaning: STAGE_DEFINITIONS[stage],
    })),
    users: rows.map((r) => ({
      ticket_id: Number(r.ticket_id || 0),
      date: r.date,
      name: r.name || "",
      phone_number: r.phone_number || "",
      projects_browsed: r.projects_browsed || "-",
      lead_projects: r.lead_projects || "-",
      lead_submitted: r.lead_submitted,
      callback_requested: r.callback_requested,
      callback_confirmed: r.callback_confirmed,
      stage: r.stage,
    })),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ detail: "Method not allowed" });

  if (!METABASE_API_KEY) {
    return res.status(500).json({ detail: "METABASE_API_KEY is not configured" });
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
    const rows = await executeQuery(CLICKHOUSE_DATABASE_ID, userDetailSql(startDate, endDate));
    return res.status(200).json(buildReport(rows, startDate, endDate));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate report";
    return res.status(502).json({ detail: message });
  }
}
