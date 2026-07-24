PROJECTS = [
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
]

# Case-insensitive aliases used for browse detection in live SQL
PROJECT_ALIAS_PATTERNS = [
    ("7 mahalaxmi", "7 Mahalaxmi"),
    ("runwal garden city", "Runwal Garden City"),
    ("runwal forests", "Runwal Forests"),
    ("runwal forest", "Runwal Forests"),
    ("runwal pinnacle", "Runwal Pinnacle"),
    ("codename forevergreen", "Codename Forevergreen"),
    ("runwal woods", "Runwal Woods"),
    ("runwal avenue", "Runwal Avenue"),
    ("runwal bliss", "Runwal Bliss"),
    ("fifth avenue", "Fifth Avenue"),
    ("runwal city center", "Runwal City Center"),
    ("runwal city centre", "Runwal City Center"),
]

PROJECT_LIST_SQL = ", ".join(f"'{p}'" for p in PROJECTS)
PROJECT_LOWER_SQL = ", ".join(f"'{p.lower()}'" for p in PROJECTS)

STAGE_DEFINITIONS = {
    "Lead Confirmed": "Form submitted + system confirmed callback registration — fully qualified lead",
    "Requested Callback – Not Confirmed": "Filled form + clicked callback button, but system confirmation not triggered",
    "Lead Submitted – Dropped": "Form submitted (gave name/number/budget/config) but never clicked callback button",
    "Callback Clicked – Dropped Mid-Form": 'Clicked "Request A Call Back" but dropped before completing form details',
    "Project Browsed – Dropped": "Selected a project but took no further action — no callback, no form",
    "No Action": "No project interaction — job seekers, vendors, existing buyers, off-topic",
}


def _normalize_expr(content_expr: str) -> str:
    """ClickHouse expression mapping free-text / casing variants to canonical project names."""
    return "multiIf(" + ", ".join(
        f"positionCaseInsensitive({content_expr}, '{alias}') > 0, '{canonical}'"
        for alias, canonical in PROJECT_ALIAS_PATTERNS
    ) + ", NULL)"


def user_detail_sql(account_id: int, start_date: str, end_date: str) -> str:
    """Return one row per conversation with funnel flags and project lists."""
    normalize_inbound = _normalize_expr("content")
    return f"""
WITH
params AS (
  SELECT
    toDateTime('{start_date} 00:00:00') AS start_ts,
    toDateTime(addDays(toDate('{end_date}'), 1)) AS end_ts
),
convs AS (
  SELECT
    id,
    display_id,
    contact_id,
    created_at,
    row_number() OVER (PARTITION BY display_id ORDER BY updated_at DESC, id DESC) AS rn
  FROM datawarehouse.postgres_conv_conversations
  WHERE account_id = {account_id}
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
    m.content,
    m.created_at
  FROM datawarehouse.postgres_hd_messages m
  INNER JOIN uniq_convs c ON c.id = m.conversation_id
  WHERE m.account_id = {account_id}
),
browse_events AS (
  SELECT
    conversation_id,
    arrayDistinct(groupArray(
      multiIf(
        message_type = 0 AND (
          content IN ({PROJECT_LIST_SQL})
          OR lowerUTF8(trim(BOTH ' ' FROM content)) IN ({PROJECT_LOWER_SQL})
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
        {normalize_inbound},
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
"""
