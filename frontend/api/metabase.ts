type MetabaseRow = Record<string, unknown>;

export async function executeMetabaseQuery(
  databaseId: number,
  sql: string,
): Promise<MetabaseRow[]> {
  const baseUrl = (process.env.METABASE_URL || "https://metabase.limechat.ai").replace(/\/$/, "");
  const apiKey = process.env.METABASE_API_KEY || "";
  if (!apiKey) {
    throw new Error("METABASE_API_KEY is not configured on the server");
  }

  const response = await fetch(`${baseUrl}/api/dataset`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      database: databaseId,
      type: "native",
      native: { query: sql },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Metabase HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    status?: string;
    error?: string;
    data?: { cols?: Array<{ name: string }>; rows?: unknown[][] };
  };

  if (data.status === "failed") {
    throw new Error(data.error || "Metabase query failed");
  }

  const cols = (data.data?.cols || []).map((c) => c.name);
  const rows = data.data?.rows || [];
  return rows.map((row) => {
    const obj: MetabaseRow = {};
    cols.forEach((name, i) => {
      obj[name] = row[i];
    });
    return obj;
  });
}
