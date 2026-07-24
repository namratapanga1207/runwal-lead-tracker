# Runwal Bot Lead Tracker

Date-filtered funnel dashboard for **Runwal Enterprises** (LimeChat account `28982`), matching the Bot Lead Tracker sheet.

Live app: [https://runwal-lead-tracker.vercel.app](https://runwal-lead-tracker.vercel.app)

Repo: [namratapanga1207/runwal-lead-tracker](https://github.com/namratapanga1207/runwal-lead-tracker)

## Validation (Mar 10 – May 10, 2026)

| Metric | Sheet | Live API |
|--------|------:|---------:|
| Total Conversations | 230 | 230 |
| Unique Phone Numbers | 193 | 193 |
| Leads Generated | 58 | 58 |
| Callback Requested | 56 | 56 |
| Leads Confirmed | 38 | 38 |
| Lead Confirmed stage | 38 | 38 |
| Requested Callback – Not Confirmed | 9 | 9 |
| Lead Submitted – Dropped | 11 | 11 |
| Callback Clicked – Dropped Mid-Form | 24 | 24 |

Project browsed / no-action can differ by ~2 vs the sheet depending on how edge-case project selections are labeled.

## Architecture

- **Frontend (Vercel):** React dashboard with date filters, stage mix, project table, drop-off analysis, user detail
- **API:** Metabase native SQL over ClickHouse conversations/messages (+ HDT contacts for phones)
- **FastAPI service (`backend/`):** Ready for Render deployment (`render.yaml`)

## Local development

### Backend (FastAPI)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # set METABASE_API_KEY
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env   # VITE_API_BASE_URL=http://localhost:8000
npm run dev
```

## Deploy

### Vercel (frontend + API route)

Already deployed. Env vars on the Vercel project:
- `METABASE_URL`
- `METABASE_API_KEY`
- `ACCOUNT_ID=28982`
- `CLICKHOUSE_DATABASE_ID=82`

Optional: set `VITE_API_BASE_URL` to a Render API URL to point the UI at FastAPI instead of `/api/report`.

### Render (FastAPI backend)

1. Open Blueprint deploy:  
   [https://dashboard.render.com/blueprint/new?repo=https://github.com/namratapanga1207/runwal-lead-tracker](https://dashboard.render.com/blueprint/new?repo=https://github.com/namratapanga1207/runwal-lead-tracker)
2. Set env vars:
   - `METABASE_URL=https://metabase.limechat.ai`
   - `METABASE_API_KEY=<your key>`
   - `CORS_ORIGINS=https://runwal-lead-tracker.vercel.app`
3. After deploy, set Vercel `VITE_API_BASE_URL` to `https://<render-service>.onrender.com` and redeploy the frontend.

Or with Render CLI (after `render login`):

```bash
render blueprints validate ./render.yaml
# then deploy blueprint from the dashboard linked to this repo
```

## Data definitions

Funnel stages are derived from bot messages for account `28982`:

- **Project browsed:** inbound project list selection
- **Callback requested:** inbound `Request A Call Back`
- **Lead submitted:** bot verification message containing `Interested project:`
- **Lead confirmed:** bot message containing `successfully registered`
