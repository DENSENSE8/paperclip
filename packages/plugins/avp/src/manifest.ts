import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export const PLUGIN_ID = "avp";

export const MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "AVP Trust & Reputation",
  description:
    "Agent Verification Protocol: EigenTrust-based reputation scoring, delegation gating, and trust network health for agent fleets.",
  author: "DENSENSE8",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "agents.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      initialTrustScore: {
        type: "number",
        title: "Initial Trust Score",
        default: 0.5,
      },
      delegationThreshold: {
        type: "number",
        title: "Delegation Trust Threshold",
        default: 0.3,
      },
      emaSmoothingFactor: {
        type: "number",
        title: "EMA Smoothing Factor (alpha)",
        default: 0.2,
      },
    },
  },
};

export default MANIFEST;
