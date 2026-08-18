import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginConfigValidationResult,
} from "@paperclipai/plugin-sdk";
import { MANIFEST } from "./manifest.js";

interface AvpConfig {
  initialTrustScore: number;
  delegationThreshold: number;
  emaSmoothingFactor: number;
}

interface TrustRecord {
  score: number;
  interactions: number;
  lastUpdated: string;
  did: string;
}

function generateDid(agentId: string): string {
  const hash = Array.from(agentId)
    .reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0)
    .toString(16);
  return `did:avp:agent:${hash}`;
}

let currentContext: PluginContext | null = null;

async function getConfig(): Promise<AvpConfig> {
  const ctx = currentContext;
  if (!ctx) return { initialTrustScore: 0.5, delegationThreshold: 0.3, emaSmoothingFactor: 0.2 };
  const raw = await ctx.config.get();
  const cfg = raw as unknown as Partial<AvpConfig> | null;
  return {
    initialTrustScore: cfg?.initialTrustScore ?? 0.5,
    delegationThreshold: cfg?.delegationThreshold ?? 0.3,
    emaSmoothingFactor: cfg?.emaSmoothingFactor ?? 0.2,
  };
}

async function getTrustRecord(
  ctx: PluginContext,
  agentId: string,
): Promise<TrustRecord> {
  const raw = await ctx.state.get({
    scopeKind: "agent" as never,
    scopeId: agentId,
    stateKey: "eigentrust-score",
  });
  if (raw) return raw as TrustRecord;

  const config = await getConfig();
  return {
    score: config.initialTrustScore,
    interactions: 0,
    lastUpdated: new Date().toISOString(),
    did: generateDid(agentId),
  };
}

async function saveTrustRecord(
  ctx: PluginContext,
  agentId: string,
  record: TrustRecord,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "agent" as never, scopeId: agentId, stateKey: "eigentrust-score" },
    record,
  );
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    currentContext = ctx;
    ctx.logger.info("AVP Trust plugin starting...");

    // Tool 1: Check agent reputation
    ctx.tools.register(
      "avp_check_reputation",
      {
        displayName: "Check Reputation",
        description: "Look up an agent's EigenTrust reputation score",
        parametersSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "The agent ID to check" },
          },
          required: ["agentId"],
        },
      },
      async (params: unknown) => {
        const p = params as Record<string, unknown>;
        const agentId = p.agentId as string;
        const record = await getTrustRecord(ctx, agentId);
        return {
          content: JSON.stringify({
            agentId,
            did: record.did,
            trustScore: record.score,
            interactions: record.interactions,
            lastUpdated: record.lastUpdated,
          }),
        };
      },
    );

    // Tool 2: Should delegate?
    ctx.tools.register(
      "avp_should_delegate",
      {
        displayName: "Should Delegate",
        description: "Evaluate if an agent meets the trust threshold for delegation",
        parametersSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "The agent to delegate to" },
            taskComplexity: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Complexity of the task being delegated",
            },
          },
          required: ["agentId"],
        },
      },
      async (params: unknown) => {
        const p = params as Record<string, unknown>;
        const agentId = p.agentId as string;
        const complexity = (p.taskComplexity as string) ?? "medium";
        const record = await getTrustRecord(ctx, agentId);
        const config = await getConfig();

        const multiplier = complexity === "high" ? 1.5 : complexity === "low" ? 0.7 : 1.0;
        const threshold = config.delegationThreshold * multiplier;
        const shouldDelegate = record.score >= threshold;

        return {
          content: JSON.stringify({
            agentId,
            shouldDelegate,
            trustScore: record.score,
            threshold,
            complexity,
            reason: shouldDelegate
              ? `Score ${record.score.toFixed(3)} >= threshold ${threshold.toFixed(3)}`
              : `Score ${record.score.toFixed(3)} < threshold ${threshold.toFixed(3)}`,
          }),
        };
      },
    );

    // Tool 3: Log interaction outcome
    ctx.tools.register(
      "avp_log_interaction",
      {
        displayName: "Log Interaction",
        description: "Record an interaction outcome to update trust scoring",
        parametersSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "The agent involved" },
            outcome: {
              type: "string",
              enum: ["success", "partial", "failure"],
              description: "Outcome of the interaction",
            },
            notes: { type: "string", description: "Optional notes" },
          },
          required: ["agentId", "outcome"],
        },
      },
      async (params: unknown) => {
        const p = params as Record<string, unknown>;
        const agentId = p.agentId as string;
        const outcome = p.outcome as string;
        const record = await getTrustRecord(ctx, agentId);
        const config = await getConfig();

        const outcomeValue =
          outcome === "success" ? 1.0 : outcome === "partial" ? 0.5 : 0.0;
        const alpha = config.emaSmoothingFactor;
        record.score = alpha * outcomeValue + (1 - alpha) * record.score;
        record.interactions += 1;
        record.lastUpdated = new Date().toISOString();

        await saveTrustRecord(ctx, agentId, record);

        return {
          content: JSON.stringify({
            agentId,
            newScore: record.score,
            interactions: record.interactions,
            outcome,
          }),
        };
      },
    );

    // Tool 4: Evaluate team trust
    ctx.tools.register(
      "avp_evaluate_team",
      {
        displayName: "Evaluate Team",
        description: "Aggregate trust metrics across all known agents",
        parametersSchema: {
          type: "object",
          properties: {
            agentIds: {
              type: "array",
              items: { type: "string" },
              description: "Agent IDs to evaluate",
            },
          },
          required: ["agentIds"],
        },
      },
      async (params: unknown) => {
        const p = params as Record<string, unknown>;
        const ids = p.agentIds as string[];
        const records: Array<{ agentId: string; record: TrustRecord }> = [];
        for (const id of ids) {
          records.push({ agentId: id, record: await getTrustRecord(ctx, id) });
        }

        const scores = records.map((r) => r.record.score);
        const avg = scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : 0;
        const min = scores.length > 0 ? Math.min(...scores) : 0;
        const max = scores.length > 0 ? Math.max(...scores) : 0;

        return {
          content: JSON.stringify({
            teamSize: records.length,
            averageTrust: avg,
            minTrust: min,
            maxTrust: max,
            agents: records.map((r) => ({
              agentId: r.agentId,
              score: r.record.score,
              interactions: r.record.interactions,
            })),
          }),
        };
      },
    );

    // Tool 5: Heartbeat / health report
    ctx.tools.register(
      "avp_heartbeat_report",
      {
        displayName: "Heartbeat Report",
        description: "Return trust network health summary",
        parametersSchema: { type: "object", properties: {} },
      },
      async () => {
        const networkStats = await ctx.state.get({
          scopeKind: "instance",
          stateKey: "network-stats",
        });
        return {
          content: JSON.stringify({
            status: "healthy",
            timestamp: new Date().toISOString(),
            networkStats: networkStats ?? {
              totalAgents: 0,
              totalInteractions: 0,
              averageTrust: 0.5,
            },
          }),
        };
      },
    );

    // Event listener: auto-log outcomes on agent.run.finished
    ctx.events.on("agent.run.finished", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      const agentId = payload.agentId as string;
      if (!agentId) return;

      const exitCode = payload.exitCode as number;
      const outcome = exitCode === 0 ? "success" : "failure";

      const record = await getTrustRecord(ctx, agentId);
      const config = await getConfig();
      const outcomeValue = outcome === "success" ? 1.0 : 0.0;
      const alpha = config.emaSmoothingFactor;
      record.score = alpha * outcomeValue + (1 - alpha) * record.score;
      record.interactions += 1;
      record.lastUpdated = new Date().toISOString();
      await saveTrustRecord(ctx, agentId, record);

      ctx.logger.info(
        `AVP: Agent ${agentId} ${outcome} -> score ${record.score.toFixed(3)}`,
      );
    });

    ctx.logger.info("AVP Trust plugin ready");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok", message: "AVP trust network operational" };
  },

  async onValidateConfig(
    config: Record<string, unknown>,
  ): Promise<PluginConfigValidationResult> {
    const errors: string[] = [];
    if (config.initialTrustScore != null) {
      const v = config.initialTrustScore as number;
      if (v < 0 || v > 1) errors.push("Initial trust score must be between 0 and 1");
    }
    if (config.delegationThreshold != null) {
      const v = config.delegationThreshold as number;
      if (v < 0 || v > 1) errors.push("Delegation threshold must be between 0 and 1");
    }
    return { ok: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  },

  async onShutdown() {
    currentContext?.logger.info("AVP plugin shutting down");
  },
});

runWorker(plugin, import.meta.url);
