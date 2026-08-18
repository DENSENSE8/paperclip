import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export const PLUGIN_ID = "hermes-dashboard";

export const MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Hermes Memory Dashboard",
  description:
    "Memory recall viewer, PII audit trail, and cloud planner cost visualization. Ported from Garisek-OS patterns.",
  author: "DENSENSE8",
  categories: ["ui"],
  capabilities: [
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "http.outbound",
    "agents.read",
    "jobs.schedule",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      hermesSidecarUrl: {
        type: "string",
        title: "Hermes Sidecar URL",
        default: "http://localhost:8791",
      },
      honchoWorkspace: {
        type: "string",
        title: "Honcho Workspace",
        default: "avion",
      },
      showPiiAudit: {
        type: "boolean",
        title: "Show PII Audit Details",
        default: true,
      },
    },
    required: ["hermesSidecarUrl"],
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "memory-recall-widget",
        displayName: "Memory Recall",
        exportName: "MemoryRecallWidget",
      },
      {
        type: "settingsPage",
        id: "hermes-settings",
        displayName: "Hermes Configuration",
        exportName: "HermesSettingsPage",
      },
      {
        type: "detailTab",
        id: "agent-memory-tab",
        displayName: "Memory",
        exportName: "AgentMemoryTab",
        entityTypes: ["agent"],
      },
      {
        type: "dashboardWidget",
        id: "fleet-monitor-widget",
        displayName: "Fleet Monitor",
        exportName: "FleetMonitorWidget",
      },
    ],
  },
  jobs: [
    {
      jobKey: "sync-memory-stats",
      displayName: "Sync Memory Stats",
      description: "Update memory usage stats from Hermes sidecar",
      schedule: "*/10 * * * *",
    },
  ],
};

export default MANIFEST;
