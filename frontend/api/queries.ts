export const PROJECT_ORDER = [
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

const PROJECTS = [...PROJECT_ORDER, "Runwal City Centre"];

const PROJECT_ALIAS_PATTERNS: Array<[string, string]> = [
  ["7 mahalaxmi", "7 Mahalaxmi"],
  ["runwal garden city", "Runwal Garden City"],
  ["runwal forests", "Runwal Forests"],
  ["runwal forest", "Runwal Forests"],
  ["runwal pinnacle", "Runwal Pinnacle"],
  ["codename forevergreen", "Codename Forevergreen"],
  ["runwal woods", "Runwal Woods"],
  ["runwal avenue", "Runwal Avenue"],
  ["runwal bliss", "Runwal Bliss"],
  ["fifth avenue", "Fifth Avenue"],
  ["runwal city center", "Runwal City Center"],
  ["runwal city centre", "Runwal City Center"],
];

export const PROJECT_ALIASES: Record<string, string> = Object.fromEntries(PROJECT_ALIAS_PATTERNS);

export const STAGE_DEFINITIONS: Record<string, string> = {
  "Lead Confirmed": "Form submitted + system confirmed callback registration — fully qualified lead",
  "Requested Callback – Not Confirmed": "Filled form + clicked callback button, but system confirmation not triggered",
  "Lead Submitted – Dropped": "Form submitted (gave name/number/budget/config) but never clicked callback button",
  "Callback Clicked – Dropped Mid-Form": 'Clicked "Request A Call Back" but dropped before completing form details',
  "Project Browsed – Dropped": "Selected a project but took no further action — no callback, no form",
  "No Action": "No project interaction — job seekers, vendors, existing buyers, off-topic",
};

function normalizeExpr(contentExpr: string) {
  return (
    "multiIf(" +
    PROJECT_ALIAS_PATTERNS.map(
      ([alias, canonical]) => `positionCaseInsensitive(${contentExpr}, '${alias}') > 0, '${canonical}'`,
    ).join(", ") +
    ", NULL)"
  );
}

export function userDetailSql(accountId: number, startDate: string, endDate: string) {
  const projectListSql = PROJECTS.map((p) => `'${p}'`).join(", ");
  const projectLowerSql = PROJECTS.map((p) => `'${p.toLowerCase()}'`).join(", ");
  const normalizeInbound = normalizeExpr("content");

  return `
WITH
params AS (
  SELECT
    toDateTime('${startDate} 00:00:00') AS start_ts,
    toDateTime(addDays(toDate('${endDate}'), 1)) AS end_ts
),
convs AS (
  SELECT
    toInt64(id) AS id,
    display_id,
    contact_id,
    created_at,
    row_number() OVER (PARTITION BY display_id ORDER BY updated_at DESC, id DESC) AS rn
  FROM datawarehouse.postgres_conv_conversations
  WHERE account_id = ${accountId}
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
    ifNull(m.content, '') AS content,
    m.created_at
  FROM datawarehouse.postgres_hd_messages m
  INNER JOIN uniq_convs c ON c.id = m.conversation_id
  WHERE m.account_id = ${accountId}
),
browse_events AS (
  SELECT
    conversation_id,
    arrayDistinct(groupArray(
      multiIf(
        message_type = 0 AND (
          content IN (${projectListSql})
          OR lowerUTF8(trim(BOTH ' ' FROM content)) IN (${projectLowerSql})
          OR (
            length(content) <= 40
            AND (
              positionCaseInsensitive(content, 'Runwal Garden City') > 0
              OR positionCaseInsensitive(content, 'Runwal Forests') > 0
              OR positionCaseInsensitive(content, 'Runwal Forest') > 0
              OR positionCaseInsensitive(content, '7 Mahalaxmi') > 0
              OR positionCaseInsensitive(content, 'Runwal Pinnacle') > 0
              OR positionCaseInsensitive(content, 'Codename Forevergreen') > 0
              OR positionCaseInsensitive(content, 'Runwal Woods') > 0
              OR positionCaseInsensitive(content, 'Runwal Avenue') > 0
              OR positionCaseInsensitive(content, 'Runwal Bliss') > 0
              OR positionCaseInsensitive(content, 'Fifth Avenue') > 0
              OR positionCaseInsensitive(content, 'Runwal City Center') > 0
              OR positionCaseInsensitive(content, 'Runwal City Centre') > 0
            )
          )
        ),
        ${normalizeInbound},
        NULL
      )
    )) AS projects
  FROM msgs
  GROUP BY conversation_id
),
lead_events AS (
  SELECT
    conversation_id,
    arrayDistinct(
      arrayMap(
        x -> trim(BOTH ' \\n\\r' FROM x),
        arrayFlatten(groupArray(extractAll(content, 'Interested project:\\\\s*([^\\\\n\\\\r*]+)')))
      )
    ) AS lead_projects_raw
  FROM msgs
  WHERE message_type = 1 AND position(content, 'Interested project:') > 0
  GROUP BY conversation_id
),
flags AS (
  SELECT
    m.conversation_id,
    max(if(message_type = 0 AND lowerUTF8(content) = 'request a call back', 1, 0)) AS callback_requested,
    max(if(message_type = 1 AND positionCaseInsensitive(content, 'successfully registered') > 0, 1, 0)) AS callback_confirmed,
    max(if(message_type = 1 AND position(content, 'Interested project:') > 0, 1, 0)) AS lead_submitted,
    nullIf(trim(BOTH ' \\n\\r' FROM extract(
      anyIf(content, message_type = 1 AND position(content, 'Name:') > 0),
      'Name:\\\\s*([^\\\\n\\\\r*]+)'
    )), '') AS form_name,
    nullIf(trim(BOTH ' \\n\\r' FROM extract(
      anyIf(content, message_type = 1 AND position(content, 'Mobile No:') > 0),
      'Mobile No:\\\\s*([^\\\\n\\\\r*]+)'
    )), '') AS form_phone
  FROM msgs m
  GROUP BY m.conversation_id
)
SELECT
  c.display_id AS ticket_id,
  formatDateTime(c.created_at, '%Y-%m-%d') AS date,
  coalesce(nullIf(f.form_name, ''), '') AS name,
  coalesce(nullIf(f.form_phone, ''), '') AS phone_number,
  if(empty(b.projects) OR b.projects IS NULL, '-', arrayStringConcat(arrayFilter(x -> x IS NOT NULL AND x != '', b.projects), ', ')) AS projects_browsed,
  if(
    empty(l.lead_projects_raw) OR l.lead_projects_raw IS NULL,
    '-',
    arrayStringConcat(arrayFilter(x -> x IS NOT NULL AND x != '', l.lead_projects_raw), ', ')
  ) AS lead_projects,
  if(coalesce(f.lead_submitted, 0) = 1, 'Yes', 'No') AS lead_submitted,
  if(coalesce(f.callback_requested, 0) = 1, 'Yes', 'No') AS callback_requested,
  if(coalesce(f.callback_confirmed, 0) = 1, 'Yes', 'No') AS callback_confirmed,
  multiIf(
    coalesce(f.callback_confirmed, 0) = 1, 'Lead Confirmed',
    coalesce(f.lead_submitted, 0) = 1 AND coalesce(f.callback_requested, 0) = 1, 'Requested Callback – Not Confirmed',
    coalesce(f.lead_submitted, 0) = 1 AND coalesce(f.callback_requested, 0) = 0, 'Lead Submitted – Dropped',
    coalesce(f.callback_requested, 0) = 1 AND coalesce(f.lead_submitted, 0) = 0, 'Callback Clicked – Dropped Mid-Form',
    length(arrayFilter(x -> x IS NOT NULL AND x != '', ifNull(b.projects, []))) > 0, 'Project Browsed – Dropped',
    'No Action'
  ) AS stage
FROM uniq_convs c
LEFT JOIN flags f ON c.id = f.conversation_id
LEFT JOIN browse_events b ON c.id = b.conversation_id
LEFT JOIN lead_events l ON c.id = l.conversation_id
ORDER BY c.display_id
`;
}
