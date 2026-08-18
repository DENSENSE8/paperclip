import React, { useEffect, useState, useCallback } from "react";

interface AttentionItem {
  id: string;
  priority: "now" | "next" | "ambient";
  title: string;
  source: string;
  sourceEvent: string;
  agentId?: string;
  createdAt: string;
}

interface QueueStats {
  total: number;
  now: number;
  next: number;
  ambient: number;
}

type Bridge = {
  data: (key: string, params?: unknown) => Promise<unknown>;
  action: (key: string, params?: unknown) => Promise<unknown>;
};

const priorityColors: Record<string, string> = {
  now: "#ef4444",
  next: "#f59e0b",
  ambient: "#6b7280",
};

const priorityLabels: Record<string, string> = {
  now: "NOW",
  next: "NEXT",
  ambient: "AMBIENT",
};

export function AperturePriorityWidget({ bridge }: { bridge: Bridge }) {
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [items, setItems] = useState<AttentionItem[]>([]);

  const refresh = useCallback(async () => {
    const s = await bridge.data("queue-stats");
    setStats(s as QueueStats);
    const q = await bridge.data("attention-queue");
    setItems((q as AttentionItem[]) ?? []);
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);

  const dismiss = async (id: string) => {
    await bridge.action("dismiss-item", { itemId: id });
    await refresh();
  };

  const nowItems = items.filter((i) => i.priority === "now").slice(0, 5);
  const nextItems = items.filter((i) => i.priority === "next").slice(0, 3);

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: "0 0 12px" }}>Priority Queue</h3>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12, fontSize: 12 }}>
        <span style={{ color: priorityColors.now, fontWeight: 700 }}>
          {stats?.now ?? 0} NOW
        </span>
        <span style={{ color: priorityColors.next, fontWeight: 600 }}>
          {stats?.next ?? 0} NEXT
        </span>
        <span style={{ color: priorityColors.ambient }}>
          {stats?.ambient ?? 0} ambient
        </span>
      </div>

      {/* Now items */}
      {nowItems.map((item) => (
        <div
          key={item.id}
          style={{
            padding: "8px 10px",
            marginBottom: 4,
            borderLeft: `3px solid ${priorityColors.now}`,
            background: "rgba(239,68,68,0.08)",
            borderRadius: 4,
            fontSize: 13,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <span style={{ fontWeight: 600 }}>{item.title}</span>
            <div style={{ fontSize: 11, opacity: 0.6 }}>
              {item.sourceEvent} | {item.source}
            </div>
          </div>
          <button
            onClick={() => void dismiss(item.id)}
            style={{ fontSize: 11, cursor: "pointer", border: "none", background: "transparent", opacity: 0.5 }}
          >
            dismiss
          </button>
        </div>
      ))}

      {/* Next items (compact) */}
      {nextItems.map((item) => (
        <div
          key={item.id}
          style={{
            padding: "6px 10px",
            marginBottom: 2,
            borderLeft: `2px solid ${priorityColors.next}`,
            fontSize: 12,
            opacity: 0.8,
          }}
        >
          {item.title}
        </div>
      ))}

      {items.length === 0 && (
        <div style={{ opacity: 0.5, fontSize: 13, padding: "8px 0" }}>
          All clear. No items in queue.
        </div>
      )}
    </div>
  );
}

export function ApertureDashboard({ bridge }: { bridge: Bridge }) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [filter, setFilter] = useState<"all" | "now" | "next" | "ambient">("all");

  const refresh = useCallback(async () => {
    const q = await bridge.data("attention-queue");
    setItems((q as AttentionItem[]) ?? []);
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);

  const dismiss = async (id: string) => {
    await bridge.action("dismiss-item", { itemId: id });
    await refresh();
  };

  const promote = async (id: string) => {
    await bridge.action("promote-item", { itemId: id });
    await refresh();
  };

  const filtered = filter === "all" ? items : items.filter((i) => i.priority === filter);

  const tabStyle = (active: boolean) => ({
    padding: "6px 14px",
    cursor: "pointer" as const,
    border: "none",
    background: active ? "rgba(99,102,241,0.15)" : "transparent",
    color: active ? "#6366f1" : "inherit",
    borderRadius: 4,
    fontSize: 13,
  });

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 16 }}>Attention Dashboard</h2>

      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        <button style={tabStyle(filter === "all")} onClick={() => setFilter("all")}>
          All ({items.length})
        </button>
        <button style={tabStyle(filter === "now")} onClick={() => setFilter("now")}>
          Now ({items.filter((i) => i.priority === "now").length})
        </button>
        <button style={tabStyle(filter === "next")} onClick={() => setFilter("next")}>
          Next ({items.filter((i) => i.priority === "next").length})
        </button>
        <button style={tabStyle(filter === "ambient")} onClick={() => setFilter("ambient")}>
          Ambient ({items.filter((i) => i.priority === "ambient").length})
        </button>
      </div>

      <div style={{ maxHeight: 500, overflowY: "auto" }}>
        {filtered.map((item) => (
          <div
            key={item.id}
            style={{
              padding: "10px 12px",
              marginBottom: 6,
              borderLeft: `3px solid ${priorityColors[item.priority]}`,
              background: item.priority === "now" ? "rgba(239,68,68,0.05)" : "transparent",
              borderRadius: 4,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
            }}
          >
            <div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: priorityColors[item.priority],
                    textTransform: "uppercase",
                  }}
                >
                  {priorityLabels[item.priority]}
                </span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{item.title}</span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>
                {item.sourceEvent} | {item.source} |{" "}
                {new Date(item.createdAt).toLocaleTimeString()}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {item.priority !== "now" && (
                <button
                  onClick={() => void promote(item.id)}
                  style={{ fontSize: 11, cursor: "pointer", border: "1px solid rgba(128,128,128,0.3)", borderRadius: 3, padding: "2px 8px", background: "transparent" }}
                >
                  promote
                </button>
              )}
              <button
                onClick={() => void dismiss(item.id)}
                style={{ fontSize: 11, cursor: "pointer", border: "1px solid rgba(128,128,128,0.3)", borderRadius: 3, padding: "2px 8px", background: "transparent", opacity: 0.6 }}
              >
                dismiss
              </button>
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div style={{ opacity: 0.5, fontSize: 13, padding: 16, textAlign: "center" }}>
            {filter === "all" ? "Queue is empty." : `No ${filter} items.`}
          </div>
        )}
      </div>
    </div>
  );
}

export function ApertureSettingsPage({ bridge }: { bridge: Bridge }) {
  const [stats, setStats] = useState<QueueStats | null>(null);

  useEffect(() => {
    bridge.data("queue-stats").then((d) => setStats(d as QueueStats));
  }, [bridge]);

  return (
    <div style={{ padding: 24 }}>
      <h2>Aperture Configuration</h2>
      <p style={{ opacity: 0.7 }}>
        Configure queue limits and retention in the plugin settings above.
      </p>

      <h3>Queue Stats</h3>
      <ul>
        <li>Total items: {stats?.total ?? 0}</li>
        <li style={{ color: "#ef4444" }}>NOW (urgent): {stats?.now ?? 0}</li>
        <li style={{ color: "#f59e0b" }}>NEXT (staged): {stats?.next ?? 0}</li>
        <li style={{ color: "#6b7280" }}>AMBIENT (info): {stats?.ambient ?? 0}</li>
      </ul>

      <h3>Attention Pipeline</h3>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        Events flow through: <strong>Arrive</strong> &rarr; <strong>Classify</strong>{" "}
        (now/next/ambient) &rarr; <strong>Show</strong> &rarr; <strong>Respond</strong>
      </p>
      <ul style={{ fontSize: 13 }}>
        <li><strong>NOW</strong>: Blocked approvals, failed runs, high-cost alerts</li>
        <li><strong>NEXT</strong>: Pending approvals, stale issues, non-zero exit codes</li>
        <li><strong>AMBIENT</strong>: Status updates, cost summaries, fleet health</li>
      </ul>
    </div>
  );
}
