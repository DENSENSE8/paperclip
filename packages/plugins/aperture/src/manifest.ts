import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export const PLUGIN_ID = "aperture";

export const MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Aperture Attention Manager",
  description:
    "Priority ranking engine with now/next/ambient classification. Surfaces urgent items, stages the queue, and keeps ambient noise low.",
  author: "DENSENSE8",
  categories: ["ui"],
  capabilities: [
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "events.emit",
    "agents.read",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      nowMaxItems: {
        type: "number",
        title: "Max 'Now' Items",
        default: 5,
      },
      nextMaxItems: {
        type: "number",
        title: "Max 'Next' Items",
        default: 15,
      },
      ambientRetentionHours: {
        type: "number",
        title: "Ambient Retention (hours)",
        default: 24,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "priority-queue-widget",
        displayName: "Priority Queue",
        exportName: "AperturePriorityWidget",
      },
      {
        type: "page",
        id: "attention-dashboard",
        displayName: "Attention Dashboard",
        exportName: "ApertureDashboard",
      },
      {
        type: "settingsPage",
        id: "aperture-settings",
        displayName: "Aperture Settings",
        exportName: "ApertureSettingsPage",
      },
    ],
  },
};

export default MANIFEST;
