import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginConfigValidationResult,
} from "@paperclipai/plugin-sdk";
import { MANIFEST } from "./manifest.js";

interface HermesConfig {
  hermesSidecarUrl: string;
  honchoWorkspace: string;
  showPiiAudit: boolean;
}

interface MemoryResult {
  query: string;
  response: string;
  source?: string;
  similarity?: number;
  timestamp?: string;
}

interface MemoryRecallResponse {
  results: MemoryResult[];
  honcho_context?: string;
  source_count?: number;
}

interface MemoryStats {
  sources: Record<string, number>;
  totalMemories: number;
  lastSynced: string;
}

async function sidecarFetch<T>(
  baseUrl: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const options: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      }
    : { signal: AbortSignal.timeout(10_000) };

  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Sidecar ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

let currentContext: PluginContext | null = null;

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    currentContext = ctx;
    ctx.logger.info("Hermes Dashboard plugin starting...");

    // Data: memory search
    ctx.data.register("memory-search", async (params) => {
      const configRaw = await ctx.config.get();
      const config = configRaw as unknown as HermesConfig | null;
      if (!config?.hermesSidecarUrl)
        return { error: "Hermes sidecar URL not configured" };

      const query = (params.query as string) ?? "";
      const limit = (params.limit as number) ?? 20;

      try {
        return await sidecarFetch<MemoryRecallResponse>(
          config.hermesSidecarUrl,
          "/api/memory/recall",
          { query, source: "paperclip", limit },
        );
      } catch (err) {
        return { error: `Memory recall failed: ${err}`, results: [] };
      }
    });

    // Data: memory stats (cached in plugin state)
    ctx.data.register("memory-stats", async () => {
      const cached = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "memory-stats",
      });
      return cached ?? { sources: {}, totalMemories: 0, lastSynced: null };
    });

    // Data: recent memories
    ctx.data.register("recent-memories", async () => {
      const configRaw = await ctx.config.get();
      const config = configRaw as unknown as HermesConfig | null;
      if (!config?.hermesSidecarUrl) return [];

      try {
        const data = await sidecarFetch<MemoryRecallResponse>(
          config.hermesSidecarUrl,
          "/api/memory/recall",
          { query: "", source: "paperclip", limit: 10 },
        );
        return data.results ?? [];
      } catch {
        return [];
      }
    });

    // Data: PII audit trail
    ctx.data.register("pii-audit-trail", async () => {
      const trail = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "pii-audit-trail",
      });
      return trail ?? [];
    });

    // Data: cost breakdown
    ctx.data.register("cost-breakdown", async () => {
      const costs = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "cost-breakdown",
      });
      return costs ?? { totalUsd: 0, entries: [] };
    });

    // Data: fleet health (agent count/status by adapter type)
    ctx.data.register("fleet-health", async () => {
      try {
        const agents = await (ctx as unknown as { agents: { list: () => Promise<Array<Record<string, unknown>>> } }).agents.list();
        const byType: Record<string, { count: number; running: number; idle: number }> = {};

        for (const agent of agents) {
          const adapterType = (agent.adapterType as string) ?? "unknown";
          if (!byType[adapterType]) {
            byType[adapterType] = { count: 0, running: 0, idle: 0 };
          }
          byType[adapterType].count += 1;
          const status = agent.status as string;
          if (status === "running") byType[adapterType].running += 1;
          else byType[adapterType].idle += 1;
        }

        return {
          totalAgents: agents.length,
          adapterTypes: byType,
          timestamp: new Date().toISOString(),
        };
      } catch {
        return { totalAgents: 0, adapterTypes: {}, timestamp: new Date().toISOString() };
      }
    });

    // Data: GSD-2 run history
    ctx.data.register("gsd2-runs", async () => {
      const runs = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "gsd2-run-history",
      });
      return runs ?? [];
    });

    // Action: search memories
    ctx.actions.register("search-memory", async (params) => {
      const configRaw = await ctx.config.get();
      const config = configRaw as unknown as HermesConfig | null;
      if (!config?.hermesSidecarUrl) return { error: "Not configured" };

      return sidecarFetch<MemoryRecallResponse>(
        config.hermesSidecarUrl,
        "/api/memory/recall",
        {
          query: params.query ?? "",
          source: params.source ?? "paperclip",
          limit: params.limit ?? 20,
        },
      );
    });

    // Action: save memory (for manual entries)
    ctx.actions.register("save-memory", async (params) => {
      const configRaw = await ctx.config.get();
      const config = configRaw as unknown as HermesConfig | null;
      if (!config?.hermesSidecarUrl) return { error: "Not configured" };

      return sidecarFetch(config.hermesSidecarUrl, "/api/memory/save", {
        query: params.query,
        response: params.response,
        source: "paperclip-manual",
      });
    });

    // Action: record PII audit entry
    ctx.actions.register("record-pii-audit", async (params) => {
      const trailRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "pii-audit-trail",
      });
      const trail = (
        Array.isArray(trailRaw) ? trailRaw : []
      ) as Array<Record<string, unknown>>;

      trail.unshift({
        timestamp: new Date().toISOString(),
        runId: params.runId,
        method: params.method,
        passed: params.passed,
        deniedPatterns: params.deniedPatterns ?? [],
        costUsd: params.costUsd ?? 0,
        model: params.model,
      });

      if (trail.length > 200) trail.length = 200;

      await ctx.state.set(
        { scopeKind: "instance", stateKey: "pii-audit-trail" },
        trail,
      );

      return { recorded: true };
    });

    // Action: record cost entry
    ctx.actions.register("record-cost", async (params) => {
      const costsRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "cost-breakdown",
      });
      const costs = (costsRaw as {
        totalUsd: number;
        entries: Array<Record<string, unknown>>;
      }) ?? { totalUsd: 0, entries: [] };

      const amount = (params.costUsd as number) ?? 0;
      costs.totalUsd += amount;
      costs.entries.unshift({
        timestamp: new Date().toISOString(),
        runId: params.runId,
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        costUsd: amount,
      });

      if (costs.entries.length > 500) costs.entries.length = 500;

      await ctx.state.set(
        { scopeKind: "instance", stateKey: "cost-breakdown" },
        costs,
      );

      return { totalUsd: costs.totalUsd };
    });

    // Event: listen for GSD-2 runs to track progress
    ctx.events.on("agent.run.finished", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      const adapterType = payload.adapterType as string;
      const adapterConfig = payload.adapterConfig as Record<string, unknown> | undefined;
      if (adapterType !== "openclaw_gateway" || adapterConfig?.profile !== "gsd2_coding") return;

      const runsRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "gsd2-run-history",
      });
      const runs = (Array.isArray(runsRaw) ? runsRaw : []) as Array<Record<string, unknown>>;

      const resultJson = payload.resultJson as Record<string, unknown> | undefined;
      runs.unshift({
        runId: payload.runId,
        agentId: payload.agentId,
        timestamp: new Date().toISOString(),
        exitCode: payload.exitCode,
        model: payload.model,
        summary: payload.summary,
        gsd2Progress: resultJson?.gsd2Progress ?? null,
      });

      if (runs.length > 100) runs.length = 100;
      await ctx.state.set(
        { scopeKind: "instance", stateKey: "gsd2-run-history" },
        runs,
      );

      ctx.logger.info(
        `GSD-2 run tracked: ${payload.runId} exit=${payload.exitCode}`,
      );
    });

    // Event: listen for cloud planner runs to auto-record audits
    ctx.events.on("agent.run.finished", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      const adapterType = payload.adapterType as string;
      const plannerConfig = payload.adapterConfig as Record<string, unknown> | undefined;
      if (adapterType !== "openclaw_gateway" || plannerConfig?.profile !== "cloud_planner") return;

      const resultJson =
        payload.resultJson as Record<string, unknown> | undefined;
      if (resultJson?.pii_audit) {
        const audit = resultJson.pii_audit as Record<string, unknown>;
        const trailRaw = await ctx.state.get({
          scopeKind: "instance",
          stateKey: "pii-audit-trail",
        });
        const trail = (
          Array.isArray(trailRaw) ? trailRaw : []
        ) as Array<Record<string, unknown>>;

        trail.unshift({
          timestamp: new Date().toISOString(),
          runId: payload.runId,
          method: audit.method ?? resultJson.abstraction_method,
          passed: true,
          deniedPatterns: [],
          costUsd: payload.costUsd ?? 0,
          model: payload.model,
          inputLength: audit.input_length,
          outputLength: audit.output_length,
        });

        if (trail.length > 200) trail.length = 200;
        await ctx.state.set(
          { scopeKind: "instance", stateKey: "pii-audit-trail" },
          trail,
        );
      }

      // Auto-record cost
      if (payload.costUsd && (payload.costUsd as number) > 0) {
        const costsRaw = await ctx.state.get({
          scopeKind: "instance",
          stateKey: "cost-breakdown",
        });
        const costs = (costsRaw as {
          totalUsd: number;
          entries: Array<Record<string, unknown>>;
        }) ?? { totalUsd: 0, entries: [] };

        const amount = payload.costUsd as number;
        costs.totalUsd += amount;
        costs.entries.unshift({
          timestamp: new Date().toISOString(),
          runId: payload.runId,
          model: payload.model,
          inputTokens: (payload.usage as Record<string, unknown>)?.inputTokens,
          outputTokens: (payload.usage as Record<string, unknown>)
            ?.outputTokens,
          costUsd: amount,
        });
        if (costs.entries.length > 500) costs.entries.length = 500;
        await ctx.state.set(
          { scopeKind: "instance", stateKey: "cost-breakdown" },
          costs,
        );
      }
    });

    // Job: periodic stats sync
    ctx.jobs.register("sync-memory-stats", async () => {
      const configRaw = await ctx.config.get();
      const config = configRaw as unknown as HermesConfig | null;
      if (!config?.hermesSidecarUrl) return;

      try {
        const health = await sidecarFetch<{
          status: string;
          sources?: Record<string, number>;
        }>(config.hermesSidecarUrl, "/health");

        const stats: MemoryStats = {
          sources: health.sources ?? {},
          totalMemories: Object.values(health.sources ?? {}).reduce(
            (a, b) => a + b,
            0,
          ),
          lastSynced: new Date().toISOString(),
        };

        await ctx.state.set(
          { scopeKind: "instance", stateKey: "memory-stats" },
          stats,
        );
        ctx.logger.info(
          `Memory stats synced: ${stats.totalMemories} total memories`,
        );
      } catch (err) {
        ctx.logger.error(`Memory stats sync failed: ${err}`);
      }
    });

    ctx.logger.info("Hermes Dashboard plugin ready");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) return { status: "error", message: "Plugin not initialized" };

    const configRaw = await ctx.config.get();
    const config = configRaw as unknown as HermesConfig | null;

    if (!config?.hermesSidecarUrl) {
      return {
        status: "error",
        message: "Hermes sidecar URL not configured",
      };
    }

    try {
      const res = await fetch(`${config.hermesSidecarUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        return { status: "ok", message: "Hermes sidecar healthy" };
      }
      return {
        status: "degraded",
        message: `Sidecar HTTP ${res.status}`,
      };
    } catch {
      return {
        status: "degraded",
        message: "Hermes sidecar unreachable",
      };
    }
  },

  async onConfigChanged(): Promise<void> {
    currentContext?.logger.info("Hermes config changed");
  },

  async onValidateConfig(
    config: Record<string, unknown>,
  ): Promise<PluginConfigValidationResult> {
    if (
      !config.hermesSidecarUrl ||
      typeof config.hermesSidecarUrl !== "string"
    ) {
      return { ok: false, errors: ["Sidecar URL is required"] };
    }
    return { ok: true };
  },

  async onShutdown() {
    currentContext?.logger.info("Hermes Dashboard plugin shutting down");
  },
});

runWorker(plugin, import.meta.url);
