import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./App.css";

type StageRow = {
  stage: string;
  users: number;
  pct_of_total: number;
  meaning: string;
};

type ProjectRow = {
  project: string;
  total_clicks: number;
  leads_generated: number;
  callback_requested: number;
  lead_confirmed: number;
  dropped_after_form_submit: number;
  dropped_after_project_click: number;
  lead_confirm_rate: number | null;
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

type Report = {
  account_id: number;
  website: string;
  start_date: string;
  end_date: string;
  funnel: {
    total_conversations: number;
    unique_phone_numbers: number;
    leads_generated: number;
    callback_requested: number;
    leads_confirmed: number;
    no_action: number;
  };
  stages: StageRow[];
  projects: ProjectRow[];
  project_totals: {
    total_clicks: number;
    leads_generated: number;
    callback_requested: number;
    lead_confirmed: number;
  };
  dropoffs: StageRow[];
  users: UserRow[];
};

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

const STAGE_COLORS: Record<string, string> = {
  "Lead Confirmed": "#1f7a4d",
  "Requested Callback – Not Confirmed": "#c47b16",
  "Lead Submitted – Dropped": "#b45309",
  "Callback Clicked – Dropped Mid-Form": "#9a3412",
  "Project Browsed – Dropped": "#334155",
  "No Action": "#94a3b8",
};

function formatRange(start: string, end: string) {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  const s = new Date(`${start}T00:00:00`).toLocaleDateString("en-IN", opts);
  const e = new Date(`${end}T00:00:00`).toLocaleDateString("en-IN", opts);
  return `${s} – ${e}`;
}

export default function App() {
  const [startDate, setStartDate] = useState("2026-03-10");
  const [endDate, setEndDate] = useState("2026-05-10");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"summary" | "users">("summary");
  const [stageFilter, setStageFilter] = useState("All");

  async function loadReport(nextStart = startDate, nextEnd = endDate) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/report?start_date=${nextStart}&end_date=${nextEnd}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as Report;
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load report");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReport();
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredUsers = useMemo(() => {
    if (!report) return [];
    if (stageFilter === "All") return report.users;
    return report.users.filter((u) => u.stage === stageFilter);
  }, [report, stageFilter]);

  return (
    <div className="page">
      <div className="atmosphere" aria-hidden />
      <header className="topbar">
        <div>
          <p className="eyebrow">Bot Lead Tracker</p>
          <h1>Runwal Enterprises</h1>
          <p className="subtitle">
            Account {report?.account_id ?? 28982} ·{" "}
            <a href="https://runwalenterprises.com/" target="_blank" rel="noreferrer">
              runwalenterprises.com
            </a>
          </p>
        </div>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            void loadReport();
          }}
        >
          <label>
            From
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </button>
        </form>
      </header>

      {error && <div className="banner error">{error}</div>}

      {report && (
        <>
          <section className="hero-strip">
            <div>
              <h2>Overall Funnel Summary</h2>
              <p>{formatRange(report.start_date, report.end_date)}</p>
            </div>
            <div className="tabs">
              <button className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}>
                Summary
              </button>
              <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
                User Detail
              </button>
            </div>
          </section>

          {tab === "summary" ? (
            <>
              <section className="kpi-grid">
                <Kpi label="Total Conversations" value={report.funnel.total_conversations} />
                <Kpi label="Unique Phone Numbers" value={report.funnel.unique_phone_numbers} />
                <Kpi label="Leads Generated" value={report.funnel.leads_generated} />
                <Kpi label="Callback Requested" value={report.funnel.callback_requested} />
                <Kpi label="Leads Confirmed" value={report.funnel.leads_confirmed} accent />
                <Kpi label="No Action" value={report.funnel.no_action} muted />
              </section>

              <section className="panel-grid">
                <article className="panel">
                  <h3>Stage Mix</h3>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie
                          data={report.stages}
                          dataKey="users"
                          nameKey="stage"
                          innerRadius={58}
                          outerRadius={100}
                          paddingAngle={2}
                        >
                          {report.stages.map((s) => (
                            <Cell key={s.stage} fill={STAGE_COLORS[s.stage] || "#64748b"} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="legend">
                    {report.stages.map((s) => (
                      <li key={s.stage}>
                        <span style={{ background: STAGE_COLORS[s.stage] }} />
                        <div>
                          <strong>
                            {s.stage} · {s.users} ({s.pct_of_total}%)
                          </strong>
                          <p>{s.meaning}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </article>

                <article className="panel">
                  <h3>Project Interest</h3>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height={320}>
                      <BarChart data={report.projects} layout="vertical" margin={{ left: 24, right: 12 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis type="number" />
                        <YAxis type="category" dataKey="project" width={140} tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Bar dataKey="total_clicks" name="Project Clicks" fill="#0f4c5c" radius={[0, 4, 4, 0]} />
                        <Bar dataKey="lead_confirmed" name="Confirmed" fill="#1f7a4d" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </article>
              </section>

              <section className="panel">
                <h3>Project-wise Interest Breakdown</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>Total Clicks</th>
                        <th>Leads Generated</th>
                        <th>Callback Requested</th>
                        <th>Lead Confirmed</th>
                        <th>Dropped After Form</th>
                        <th>Dropped After Project</th>
                        <th>Confirm Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.projects.map((p) => (
                        <tr key={p.project}>
                          <td>{p.project}</td>
                          <td>{p.total_clicks}</td>
                          <td>{p.leads_generated}</td>
                          <td>{p.callback_requested}</td>
                          <td>{p.lead_confirmed}</td>
                          <td>{p.dropped_after_form_submit}</td>
                          <td>{p.dropped_after_project_click}</td>
                          <td>{p.lead_confirm_rate == null ? "—" : `${p.lead_confirm_rate}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>TOTAL</td>
                        <td>{report.project_totals.total_clicks}</td>
                        <td>{report.project_totals.leads_generated}</td>
                        <td>{report.funnel.callback_requested}</td>
                        <td>{report.funnel.leads_confirmed}</td>
                        <td colSpan={3} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              <section className="panel">
                <h3>Drop-off Analysis</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Drop Stage</th>
                        <th>Count</th>
                        <th>% of Total</th>
                        <th>What it means</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.dropoffs.map((d) => (
                        <tr key={d.stage}>
                          <td>{d.stage}</td>
                          <td>{d.users}</td>
                          <td>{d.pct_of_total}%</td>
                          <td className="meaning">{d.meaning}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            <section className="panel">
              <div className="users-toolbar">
                <h3>All User Actions ({filteredUsers.length})</h3>
                <label>
                  Stage
                  <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
                    <option>All</option>
                    {report.stages.map((s) => (
                      <option key={s.stage}>{s.stage}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Date</th>
                      <th>Name</th>
                      <th>Phone</th>
                      <th>Projects Browsed</th>
                      <th>Lead Project</th>
                      <th>Lead</th>
                      <th>Callback</th>
                      <th>Confirmed</th>
                      <th>Stage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => (
                      <tr key={u.ticket_id}>
                        <td>{u.ticket_id}</td>
                        <td>{u.date}</td>
                        <td>{u.name || "—"}</td>
                        <td>{u.phone_number || "—"}</td>
                        <td>{u.projects_browsed}</td>
                        <td>{u.lead_projects}</td>
                        <td>{u.lead_submitted}</td>
                        <td>{u.callback_requested}</td>
                        <td>{u.callback_confirmed}</td>
                        <td>
                          <span className="pill" style={{ background: STAGE_COLORS[u.stage] || "#64748b" }}>
                            {u.stage}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {!report && loading && <div className="banner">Loading report…</div>}
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
  muted,
}: {
  label: string;
  value: number;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={`kpi ${accent ? "accent" : ""} ${muted ? "muted" : ""}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString("en-IN")}</strong>
    </div>
  );
}
