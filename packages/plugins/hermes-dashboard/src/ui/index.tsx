import React, { useEffect, useState, useCallback } from "react";

interface MemoryResult {
  query: string;
  response: string;
  source?: string;
  similarity?: number;
  timestamp?: string;
}

interface MemoryStats {
  sources: Record<string, number>;
  totalMemories: number;
  lastSynced: string | null;
}

interface AuditEntry {
  timestamp: string;
  runId?: string;
  method: string;
  passed: boolean;
  deniedPatterns: string[];
  costUsd: number;
  model?: string;
}

interface CostBreakdown {
  totalUsd: number;
  entries: Array<{
    timestamp: string;
    runId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd: number;
  }>;
}

type Bridge = {
  data: (key: string, params?: unknown) => Promise<unknown>;
  action: (key: string, params?: unknown) => Promise<unknown>;
};

export function MemoryRecallWidget({ bridge }: { bridge: Bridge }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemoryResult[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    bridge.data("memory-stats").then((d) => setStats(d as MemoryStats));
    bridge.data("recent-memories").then((d) => setResults((d as MemoryResult[]) ?? []));
  }, [bridge]);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const data = await bridge.action("search-memory", { query, limit: 10 });
      const d = data as { results?: MemoryResult[] };
      setResults(d.results ?? []);
    } finally {
      setSearching(false);
    }
  }, [bridge, query]);

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: "0 0 12px" }}>Memory Recall</h3>

      {/* Stats bar */}
      <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 12 }}>
        <span>{stats?.totalMemories ?? 0} memories</span>
        <span>{Object.keys(stats?.sources ?? {}).length} sources</span>
        <span style={{ opacity: 0.6 }}>
          {stats?.lastSynced ? `Synced ${new Date(stats.lastSynced).toLocaleTimeString()}` : "Not synced"}
        </span>
      </div>

      {/* Search */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search memories..."
          style={{
            flex: 1, padding: "6px 10px", border: "1px solid rgba(128,128,128,0.3)",
            borderRadius: 4, background: "transparent", color: "inherit",
          }}
        />
        <button onClick={search} disabled={searching} style={{ padding: "6px 14px", cursor: "pointer" }}>
          {searching ? "..." : "Search"}
        </button>
      </div>

      {/* Results */}
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {results.length === 0 ? (
          <div style={{ opacity: 0.5, fontSize: 13 }}>No memories found</div>
        ) : (
          results.map((r, i) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,0.15)" }}>
              <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }}>Q: {r.query}</div>
              <div style={{ fontSize: 13, marginTop: 2 }}>{r.response.slice(0, 200)}{r.response.length > 200 ? "..." : ""}</div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>
                {r.source && <span>src: {r.source}</span>}
                {r.similarity != null && <span> | sim: {(r.similarity * 100).toFixed(0)}%</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function AgentMemoryTab({ bridge }: { bridge: Bridge }) {
  const [memories, setMemories] = useState<MemoryResult[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [costs, setCosts] = useState<CostBreakdown | null>(null);
  const [tab, setTab] = useState<"memories" | "audit" | "costs">("memories");

  useEffect(() => {
    bridge.data("recent-memories").then((d) => setMemories((d as MemoryResult[]) ?? []));
    bridge.data("pii-audit-trail").then((d) => setAudit((d as AuditEntry[]) ?? []));
    bridge.data("cost-breakdown").then((d) => setCosts(d as CostBreakdown));
  }, [bridge]);

  const tabStyle = (active: boolean) => ({
    padding: "6px 14px", cursor: "pointer" as const, border: "none",
    background: active ? "rgba(99,102,241,0.15)" : "transparent",
    color: active ? "#6366f1" : "inherit", borderRadius: 4, fontSize: 13,
  });

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        <button style={tabStyle(tab === "memories")} onClick={() => setTab("memories")}>Memories</button>
        <button style={tabStyle(tab === "audit")} onClick={() => setTab("audit")}>PII Audit</button>
        <button style={tabStyle(tab === "costs")} onClick={() => setTab("costs")}>Costs</button>
      </div>

      {tab === "memories" && (
        <div style={{ maxHeight: 400, overflowY: "auto" }}>
          {memories.map((m, i) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,0.15)" }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Q: {m.query}</div>
              <div style={{ fontSize: 13, marginTop: 2 }}>{m.response.slice(0, 300)}</div>
            </div>
          ))}
          {memories.length === 0 && <div style={{ opacity: 0.5 }}>No memories for this agent</div>}
        </div>
      )}

      {tab === "audit" && (
        <div style={{ maxHeight: 400, overflowY: "auto" }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(128,128,128,0.3)" }}>
                <th style={{ textAlign: "left", padding: 4 }}>Time</th>
                <th style={{ textAlign: "left", padding: 4 }}>Method</th>
                <th style={{ textAlign: "left", padding: 4 }}>Status</th>
                <th style={{ textAlign: "left", padding: 4 }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a, i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(128,128,128,0.1)" }}>
                  <td style={{ padding: 4 }}>{new Date(a.timestamp).toLocaleString()}</td>
                  <td style={{ padding: 4 }}>{a.method}</td>
                  <td style={{ padding: 4, color: a.passed ? "#22c55e" : "#ef4444" }}>
                    {a.passed ? "PASS" : "BLOCKED"}
                  </td>
                  <td style={{ padding: 4 }}>${a.costUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {audit.length === 0 && <div style={{ opacity: 0.5 }}>No audit entries yet</div>}
        </div>
      )}

      {tab === "costs" && (
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
            ${costs?.totalUsd.toFixed(4) ?? "0.0000"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>Total cloud planner spend</div>

          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {(costs?.entries ?? []).slice(0, 20).map((e, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12, borderBottom: "1px solid rgba(128,128,128,0.1)" }}>
                <span>{new Date(e.timestamp).toLocaleString()}</span>
                <span>{e.model}</span>
                <span>{e.inputTokens ?? 0}+{e.outputTokens ?? 0} tok</span>
                <span>${e.costUsd.toFixed(4)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function HermesSettingsPage({ bridge }: { bridge: Bridge }) {
  const [stats, setStats] = useState<MemoryStats | null>(null);

  useEffect(() => {
    bridge.data("memory-stats").then((d) => setStats(d as MemoryStats));
  }, [bridge]);

  return (
    <div style={{ padding: 24 }}>
      <h2>Hermes Memory Configuration</h2>
      <p style={{ opacity: 0.7 }}>
        Configure the Hermes sidecar URL and workspace in the plugin settings above.
      </p>

      <h3>Memory Stats</h3>
      {stats ? (
        <div>
          <p>Total memories: <strong>{stats.totalMemories}</strong></p>
          <p>Last synced: {stats.lastSynced ? new Date(stats.lastSynced).toLocaleString() : "Never"}</p>
          {Object.keys(stats.sources).length > 0 && (
            <div>
              <h4>Sources</h4>
              <ul>
                {Object.entries(stats.sources).map(([src, count]) => (
                  <li key={src}>{src}: {count}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p style={{ opacity: 0.5 }}>No stats available. Configure the sidecar URL and wait for the next sync.</p>
      )}

      <h3>Integration Points</h3>
      <ul style={{ fontSize: 13 }}>
        <li><strong>CEO Agent</strong>: Recalls context before each task, saves decisions after</li>
        <li><strong>Cloud Planner</strong>: PII audit logged per run, costs tracked</li>
        <li><strong>Sidecar</strong>: Stats synced every 10 minutes via job</li>
      </ul>
    </div>
  );
}


interface FleetHealth {
  totalAgents: number;
  adapterTypes: Record<string, { count: number; running: number; idle: number }>;
  timestamp: string;
}

interface Gsd2Run {
  runId: string;
  agentId: string;
  timestamp: string;
  exitCode: number;
  model: string;
  summary: string;
  gsd2Progress: {
    currentMilestone: string | null;
    currentSlice: string | null;
    completedTasks: number;
    totalTasks: number;
  } | null;
}

export function FleetMonitorWidget({ bridge }: { bridge: Bridge }) {
  const [health, setHealth] = useState<FleetHealth | null>(null);
  const [gsd2Runs, setGsd2Runs] = useState<Gsd2Run[]>([]);

  useEffect(() => {
    bridge.data("fleet-health").then((d) => setHealth(d as FleetHealth));
    bridge.data("gsd2-runs").then((d) => setGsd2Runs((d as Gsd2Run[]) ?? []));
  }, [bridge]);

  const adapterColors: Record<string, string> = {
    claude_local: "#6366f1",
    ceo_local: "#22c55e",
    cloud_plan: "#3b82f6",
    gsd2_local: "#f59e0b",
    pi_local: "#8b5cf6",
    codex_local: "#ec4899",
  };

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: "0 0 12px" }}>Fleet Monitor</h3>

      {/* Agent count by type */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {health && Object.entries(health.adapterTypes).map(([type, stats]) => (
          <div
            key={type}
            style={{
              padding: "4px 10px",
              borderRadius: 12,
              fontSize: 12,
              background: `${adapterColors[type] ?? "#6b7280"}20`,
              color: adapterColors[type] ?? "#6b7280",
              fontWeight: 600,
            }}
          >
            {type}: {stats.count} ({stats.running} active)
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>
        {health?.totalAgents ?? 0} total agents |{" "}
        {health?.timestamp ? new Date(health.timestamp).toLocaleTimeString() : "not synced"}
      </div>

      {/* Recent GSD-2 runs */}
      {gsd2Runs.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Recent GSD-2 Runs</div>
          <div style={{ maxHeight: 150, overflowY: "auto" }}>
            {gsd2Runs.slice(0, 5).map((run, i) => (
              <div
                key={i}
                style={{
                  padding: "4px 0",
                  borderBottom: "1px solid rgba(128,128,128,0.1)",
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{run.summary?.slice(0, 50) ?? run.runId}</span>
                  <span style={{ color: run.exitCode === 0 ? "#22c55e" : "#ef4444" }}>
                    {run.exitCode === 0 ? "OK" : `exit ${run.exitCode}`}
                  </span>
                </div>
                {run.gsd2Progress && (
                  <div style={{ fontSize: 11, opacity: 0.6 }}>
                    {run.gsd2Progress.currentMilestone && `milestone: ${run.gsd2Progress.currentMilestone}`}
                    {run.gsd2Progress.completedTasks > 0 &&
                      ` | ${run.gsd2Progress.completedTasks}/${run.gsd2Progress.totalTasks} tasks`}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {!health && gsd2Runs.length === 0 && (
        <div style={{ opacity: 0.5, fontSize: 13 }}>No fleet data yet</div>
      )}
    </div>
  );
}
