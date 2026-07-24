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

PROJECT_LIST_SQL = ", ".join(f"'{p}'" for p in PROJECTS)

STAGE_DEFINITIONS = {
    "Lead Confirmed": "Form submitted + system confirmed callback registration — fully qualified lead",
    "Requested Callback – Not Confirmed": "Filled form + clicked callback button, but system confirmation not triggered",
    "Lead Submitted – Dropped": "Form submitted (gave name/number/budget/config) but never clicked callback button",
    "Callback Clicked – Dropped Mid-Form": 'Clicked "Request A Call Back" but dropped before completing form details',
    "Project Browsed – Dropped": "Selected a project but took no further action — no callback, no form",
    "No Action": "No project interaction — job seekers, vendors, existing buyers, off-topic",
}


def user_detail_sql(account_id: int, start_date: str, end_date: str) -> str:
    """Return one row per conversation with funnel flags and project lists.

    Dates are interpreted in IST calendar days, converted to ClickHouse UTC
    conversation timestamps (matching validated sheet counts).
    """
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
flags AS (
  SELECT
    conversation_id,
    max(if(message_type = 0 AND content IN ({PROJECT_LIST_SQL}), 1, 0)) AS project_browsed,
    max(if(message_type = 0 AND lowerUTF8(content) = 'request a call back', 1, 0)) AS callback_requested,
    max(if(message_type = 1 AND positionCaseInsensitive(content, 'successfully registered') > 0, 1, 0)) AS callback_confirmed,
    max(if(message_type = 1 AND position(content, 'Interested project:') > 0, 1, 0)) AS lead_submitted,
    arrayStringConcat(
      arrayDistinct(
        groupArrayIf(content, message_type = 0 AND content IN ({PROJECT_LIST_SQL}))
      ),
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
"""


def unique_phones_sql(account_id: int, start_date: str, end_date: str) -> str:
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
    row_number() OVER (PARTITION BY display_id ORDER BY updated_at DESC, id DESC) AS rn
  FROM datawarehouse.postgres_conv_conversations
  WHERE account_id = {account_id}
    AND created_at >= (SELECT start_ts FROM params)
    AND created_at < (SELECT end_ts FROM params)
),
uniq_convs AS (
  SELECT id, contact_id FROM convs WHERE rn = 1
),
form_phones AS (
  SELECT
    m.conversation_id,
    trim(BOTH ' ' FROM replaceRegexpAll(
      anyIf(m.content, m.message_type = 1 AND position(m.content, 'Mobile No:') > 0),
      '(?s).*Mobile No:\\\\s*([^\\\\n]+).*',
      '\\\\1'
    )) AS form_phone
  FROM datawarehouse.postgres_hd_messages m
  INNER JOIN uniq_convs c ON c.id = m.conversation_id
  WHERE m.account_id = {account_id}
  GROUP BY m.conversation_id
),
contact_phones AS (
  SELECT
    c.id AS conversation_id,
    ct.phone_number
  FROM uniq_convs c
  LEFT JOIN datawarehouse.postgres_contacts ct
    ON ct.id = c.contact_id AND ct.account_id = {account_id}
)
SELECT uniqExact(
  nullIf(
    replaceRegexpAll(
      coalesce(nullIf(fp.form_phone, ''), nullIf(cp.phone_number, ''), ''),
      '[^0-9]',
      ''
    ),
    ''
  )
) AS unique_phones
FROM uniq_convs u
LEFT JOIN form_phones fp ON fp.conversation_id = u.id
LEFT JOIN contact_phones cp ON cp.conversation_id = u.id
"""
