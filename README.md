# Runwal Bot Lead Tracker

Dashboard for Runwal Enterprises (LimeChat account `28982`) with date filters.

Matches the Bot Lead Tracker report structure:
- Overall funnel summary
- Stage mix / drop-off analysis
- Project-wise interest breakdown
- User-level detail

## Validation (Mar 10 – May 10, 2026)

Against the shared sheet, live DB metrics match:

| Metric | Sheet | Dashboard |
|--------|------:|----------:|
| Total Conversations | 230 | 230 |
| Unique Phone Numbers | 193 | 193 |
| Leads Generated | 58 | 58 |
| Callback Requested | 56 | 56 |
| Leads Confirmed | 38 | 38 |

## Stack

- **Frontend:** React + Vite (Vercel)
- **Backend:** FastAPI (Render)
- **Data:** Metabase native SQL over ClickHouse + HDT Postgres

## Local development

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
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

### Render (backend)

1. Create a Web Service from this repo, root directory `backend`
2. Build: `pip install -r requirements.txt`
3. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Env vars:
   - `METABASE_URL=https://metabase.limechat.ai`
   - `METABASE_API_KEY=...`
   - `CORS_ORIGINS=https://<your-vercel-app>.vercel.app`

### Vercel (frontend)

```bash
cd frontend
vercel --prod
```

Set `VITE_API_BASE_URL` to the Render service URL.
