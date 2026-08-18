import React, { useEffect, useState } from "react";
import {
  usePluginData,
  usePluginAction,
  useHostContext,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncStatus {
  lastSyncTime: string | null;
  totalSynced: number;
}

interface SyncedIssue {
  linearId: string;
  title: string;
  action: string;
  agentName: string | null;
  routeReason: string | null;
  syncedAt: string;
}

interface CompanyConfigData {
  configured: boolean;
  teamId?: string;
  hasApiKey?: boolean;
  linearApiKey?: string | null;
  gsd2AgentName?: string | null;
  ceoAgentName?: string | null;
  gsd2Labels?: string[];
  quickLabels?: string[];
  labelMap?: Record<string, string>;
  error?: string;
}

interface CompanyOverview {
  companyId: string;
  companyName: string;
  teamId: string | null;
  configured: boolean;
}

interface AllCompanyConfigsData {
  companies: CompanyOverview[];
  totalMapped: number;
}

// ---------------------------------------------------------------------------
// Dashboard Widget
// ---------------------------------------------------------------------------

export function LinearQueueWidget() {
  const { companyId } = useHostContext();
  const { data: status, loading: statusLoading } = usePluginData<SyncStatus>(
    "sync-status",
    companyId ? { companyId } : undefined,
  );
  const { data: recent, loading: recentLoading, refresh } = usePluginData<SyncedIssue[]>(
    "recent-synced",
    companyId ? { companyId } : undefined,
  );
  const triggerSync = usePluginAction("trigger-sync");
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await triggerSync(companyId ? { companyId } : undefined);
      refresh();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0 }}>Linear Queue</h3>
        <button
          onClick={handleSync}
          disabled={syncing}
          style={{ padding: "4px 12px", cursor: "pointer" }}
        >
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>
            {statusLoading ? "..." : (status?.totalSynced ?? 0)}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Total Synced</div>
        </div>
        <div>
          <div style={{ fontSize: 12 }}>
            {statusLoading
              ? "..."
              : status?.lastSyncTime
                ? new Date(status.lastSyncTime).toLocaleTimeString()
                : "Never"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Last Sync</div>
        </div>
      </div>

      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {recentLoading ? (
          <div style={{ opacity: 0.5, fontSize: 13 }}>Loading...</div>
        ) : !recent || recent.length === 0 ? (
          <div style={{ opacity: 0.5, fontSize: 13 }}>
            No synced issues yet
          </div>
        ) : (
          recent.slice(0, 10).map((issue, i) => (
            <div
              key={i}
              style={{
                padding: "6px 0",
                borderBottom: "1px solid rgba(128,128,128,0.2)",
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 500 }}>{issue.title}</div>
              <div style={{ opacity: 0.6, fontSize: 11 }}>
                {issue.action} | {issue.agentName ?? "unassigned"}
                {issue.routeReason ? ` (${issue.routeReason})` : ""} |{" "}
                {new Date(issue.syncedAt).toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Page
// ---------------------------------------------------------------------------

export function LinearSettingsPage() {
  const { companyId } = useHostContext();
  const { data: allConfigs, loading: allLoading, refresh: refreshAll } =
    usePluginData<AllCompanyConfigsData>("all-company-configs");
  const { data: status } = usePluginData<SyncStatus>(
    "sync-status",
    companyId ? { companyId } : undefined,
  );

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(
    companyId,
  );
  const [formTeamId, setFormTeamId] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formGsd2Agent, setFormGsd2Agent] = useState("");
  const [formCeoAgent, setFormCeoAgent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);

  const saveConfig = usePluginAction("save-company-config");
  const { data: companyConfig, refresh: refreshConfig } =
    usePluginData<CompanyConfigData>(
      "company-config",
      selectedCompanyId ? { companyId: selectedCompanyId } : undefined,
    );

  // Load existing config into form when company selection changes
  useEffect(() => {
    if (companyConfig?.configured) {
      setFormTeamId(companyConfig.teamId ?? "");
      setFormApiKey(""); // Don't prefill API key for security
      setFormGsd2Agent(companyConfig.gsd2AgentName ?? "");
      setFormCeoAgent(companyConfig.ceoAgentName ?? "");
    } else {
      setFormTeamId("");
      setFormApiKey("");
      setFormGsd2Agent("");
      setFormCeoAgent("");
    }
  }, [companyConfig, selectedCompanyId]);

  const handleSave = async () => {
    if (!selectedCompanyId || !formTeamId || !formApiKey) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const result = (await saveConfig({
        companyId: selectedCompanyId,
        teamId: formTeamId,
        linearApiKey: formApiKey,
        gsd2AgentName: formGsd2Agent || undefined,
        ceoAgentName: formCeoAgent || undefined,
      })) as { success?: boolean; error?: string };

      if (result?.success) {
        setSaveResult("Saved successfully");
        setFormApiKey("");
        refreshConfig();
        refreshAll();
      } else {
        setSaveResult(`Error: ${result?.error ?? "unknown"}`);
      }
    } catch (err) {
      setSaveResult(`Error: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <h2>Linear Sync Configuration</h2>
      <p style={{ opacity: 0.7 }}>
        Configure Linear API credentials and routing per company. Each company
        maps to its own Linear team.
      </p>

      {/* Sync Status */}
      <h3>Sync Status</h3>
      <ul>
        <li>Total synced issues: {status?.totalSynced ?? 0}</li>
        <li>Last sync: {status?.lastSyncTime ?? "Never"}</li>
      </ul>

      {/* Webhook URL */}
      <h3>Webhook URL</h3>
      <p
        style={{
          fontFamily: "monospace",
          fontSize: 13,
          background: "rgba(128,128,128,0.1)",
          padding: 8,
          borderRadius: 4,
        }}
      >
        POST /_plugins/linear-sync/webhooks/linear-events
      </p>
      <p style={{ fontSize: 12, opacity: 0.7 }}>
        All Linear teams use the same webhook URL. The plugin routes events by{" "}
        <code>teamId</code> to the correct company.
      </p>

      {/* Company Overview Table */}
      <h3>Company Connections</h3>
      {allLoading ? (
        <p>Loading companies...</p>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginBottom: 24,
            fontSize: 13,
          }}
        >
          <thead>
            <tr
              style={{
                borderBottom: "2px solid rgba(128,128,128,0.3)",
                textAlign: "left",
              }}
            >
              <th style={{ padding: "8px 12px" }}>Company</th>
              <th style={{ padding: "8px 12px" }}>Linear Team ID</th>
              <th style={{ padding: "8px 12px" }}>Status</th>
              <th style={{ padding: "8px 12px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(allConfigs?.companies ?? []).map((c) => (
              <tr
                key={c.companyId}
                style={{
                  borderBottom: "1px solid rgba(128,128,128,0.15)",
                  background:
                    selectedCompanyId === c.companyId
                      ? "rgba(59,130,246,0.08)"
                      : undefined,
                }}
              >
                <td style={{ padding: "8px 12px" }}>{c.companyName}</td>
                <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>
                  {c.teamId ?? "-"}
                </td>
                <td style={{ padding: "8px 12px" }}>
                  {c.configured ? (
                    <span style={{ color: "#22c55e" }}>Connected</span>
                  ) : (
                    <span style={{ opacity: 0.5 }}>Not configured</span>
                  )}
                </td>
                <td style={{ padding: "8px 12px" }}>
                  <button
                    onClick={() => setSelectedCompanyId(c.companyId)}
                    style={{
                      padding: "2px 8px",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    Configure
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Per-Company Config Form */}
      {selectedCompanyId && (
        <div
          style={{
            border: "1px solid rgba(128,128,128,0.2)",
            borderRadius: 8,
            padding: 20,
          }}
        >
          <h3 style={{ marginTop: 0 }}>
            Configure:{" "}
            {allConfigs?.companies.find(
              (c) => c.companyId === selectedCompanyId,
            )?.companyName ?? selectedCompanyId}
          </h3>

          {companyConfig?.configured && (
            <p style={{ fontSize: 12, opacity: 0.7 }}>
              Current API key: {companyConfig.linearApiKey} | Team:{" "}
              {companyConfig.teamId}
            </p>
          )}

          <div style={{ display: "grid", gap: 12, maxWidth: 400 }}>
            <label>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Linear Team ID *
              </div>
              <input
                type="text"
                value={formTeamId}
                onChange={(e) => setFormTeamId(e.target.value)}
                placeholder="e.g. abc123def"
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(128,128,128,0.3)",
                }}
              />
            </label>

            <label>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Linear API Key *
              </div>
              <input
                type="password"
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
                placeholder="lin_api_..."
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(128,128,128,0.3)",
                }}
              />
            </label>

            <label>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                GSD-2 Agent Name
              </div>
              <input
                type="text"
                value={formGsd2Agent}
                onChange={(e) => setFormGsd2Agent(e.target.value)}
                placeholder="e.g. GSD-2 Coding"
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(128,128,128,0.3)",
                }}
              />
            </label>

            <label>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                CEO Agent Name
              </div>
              <input
                type="text"
                value={formCeoAgent}
                onChange={(e) => setFormCeoAgent(e.target.value)}
                placeholder="e.g. CEO Quick"
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(128,128,128,0.3)",
                }}
              />
            </label>

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button
                onClick={handleSave}
                disabled={saving || !formTeamId || !formApiKey}
                style={{
                  padding: "6px 16px",
                  cursor:
                    saving || !formTeamId || !formApiKey
                      ? "default"
                      : "pointer",
                  opacity: saving || !formTeamId || !formApiKey ? 0.5 : 1,
                }}
              >
                {saving ? "Saving..." : "Save Configuration"}
              </button>
              {saveResult && (
                <span
                  style={{
                    fontSize: 12,
                    color: saveResult.startsWith("Error")
                      ? "#ef4444"
                      : "#22c55e",
                  }}
                >
                  {saveResult}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
