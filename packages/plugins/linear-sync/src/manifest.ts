import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export const PLUGIN_ID = "linear-sync";

export const MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Linear Issue Sync",
  description:
    "Multi-tenant bidirectional issue sync between Paperclip and Linear. Each company maps to its own Linear team with independent API keys, routing rules, and sync state.",
  author: "DENSENSE8",
  categories: ["connector"],
  capabilities: [
    "webhooks.receive",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "agents.read",
    "agents.invoke",
    "http.outbound",
    "secrets.read-ref",
    "jobs.schedule",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "companies.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      linearApiKey: { type: "string", title: "Linear API Key" },
      teamId: { type: "string", title: "Linear Team ID" },
      labelMap: {
        type: "object",
        title: "Label to Agent Mapping",
        description:
          "Map Linear label names to Paperclip agent names (e.g. { \"backend\": \"ceo-agent\" })",
      },
      syncIntervalMinutes: {
        type: "number",
        title: "Sync Interval (minutes)",
        default: 5,
      },
      gsd2AgentName: {
        type: "string",
        title: "GSD-2 Agent Name",
        description: "Agent name to route complex/spec-driven issues to",
      },
      ceoAgentName: {
        type: "string",
        title: "CEO Agent Name",
        description: "Agent name to route quick/simple issues to",
      },
      gsd2Labels: {
        type: "array",
        title: "GSD-2 Labels",
        description: "Linear labels that route to GSD-2 agent",
        items: { type: "string" },
        default: ["large-feature", "refactor", "milestone", "spec-driven"],
      },
      quickLabels: {
        type: "array",
        title: "Quick Labels",
        description: "Linear labels that route to CEO agent",
        items: { type: "string" },
        default: ["quick-fix", "small", "bug", "chore"],
      },
    },
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "linear-queue-widget",
        displayName: "Linear Queue",
        exportName: "LinearQueueWidget",
      },
      {
        type: "settingsPage",
        id: "linear-settings",
        displayName: "Linear Configuration",
        exportName: "LinearSettingsPage",
      },
    ],
  },
  webhooks: [
    {
      endpointKey: "linear-events",
      displayName: "Linear Webhook Events",
      description: "Receives issue and comment events from Linear",
    },
  ],
  jobs: [
    {
      jobKey: "sync-linear-issues",
      displayName: "Sync Linear Issues",
      description: "Poll Linear for new/updated issues and sync to Paperclip",
      schedule: "*/5 * * * *",
    },
  ],
};

export default MANIFEST;
