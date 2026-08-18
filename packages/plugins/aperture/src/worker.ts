import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginConfigValidationResult,
} from "@paperclipai/plugin-sdk";
import { MANIFEST } from "./manifest.js";

type Priority = "now" | "next" | "ambient";

interface AttentionItem {
  id: string;
  priority: Priority;
  title: string;
  source: string;
  sourceEvent: string;
  agentId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

interface ApertureConfig {
  nowMaxItems: number;
  nextMaxItems: number;
  ambientRetentionHours: number;
}

let currentContext: PluginContext | null = null;
let itemCounter = 0;

function classifyEvent(eventType: string, payload: Record<string, unknown>): Priority {
  // Now: urgent items requiring immediate attention
  if (eventType === "approval.created") return "now";
  if (eventType === "agent.run.failed") return "now";
  if (eventType === "cost_event.created") {
    const amount = (payload.costUsd as number) ?? 0;
    if (amount > 1.0) return "now";
    return "ambient";
  }

  // Next: items that should be reviewed soon
  if (eventType === "approval.decided") return "next";
  if (eventType === "agent.run.finished") {
    const exitCode = (payload.exitCode as number) ?? 0;
    if (exitCode !== 0) return "next";
    return "ambient";
  }

  // Ambient: low-pressure background info
  return "ambient";
}

function makeId(): string {
  itemCounter += 1;
  return `attn_${Date.now()}_${itemCounter}`;
}

async function getQueue(ctx: PluginContext): Promise<AttentionItem[]> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: "attention-queue",
  });
  return (Array.isArray(raw) ? raw : []) as AttentionItem[];
}

async function saveQueue(ctx: PluginContext, queue: AttentionItem[]): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: "attention-queue" },
    queue,
  );
}

async function addItem(
  ctx: PluginContext,
  item: Omit<AttentionItem, "id" | "createdAt">,
): Promise<AttentionItem> {
  const queue = await getQueue(ctx);
  const full: AttentionItem = {
    ...item,
    id: makeId(),
    createdAt: new Date().toISOString(),
  };
  queue.unshift(full);

  // Trim queue based on config
  const configRaw = await ctx.config.get();
  const config = configRaw as unknown as ApertureConfig | null;
  const maxTotal =
    (config?.nowMaxItems ?? 5) +
    (config?.nextMaxItems ?? 15) +
    50; // ambient buffer
  if (queue.length > maxTotal) queue.length = maxTotal;

  await saveQueue(ctx, queue);
  return full;
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    currentContext = ctx;
    ctx.logger.info("Aperture Attention Manager starting...");

    // Data: full priority queue
    ctx.data.register("attention-queue", async () => {
      return await getQueue(ctx);
    });

    // Data: queue stats
    ctx.data.register("queue-stats", async () => {
      const queue = await getQueue(ctx);
      const now = queue.filter((i) => i.priority === "now");
      const next = queue.filter((i) => i.priority === "next");
      const ambient = queue.filter((i) => i.priority === "ambient");
      return {
        total: queue.length,
        now: now.length,
        next: next.length,
        ambient: ambient.length,
      };
    });

    // Action: dismiss item
    ctx.actions.register("dismiss-item", async (params) => {
      const itemId = params.itemId as string;
      const queue = await getQueue(ctx);
      const filtered = queue.filter((i) => i.id !== itemId);
      await saveQueue(ctx, filtered);
      return { dismissed: true, remaining: filtered.length };
    });

    // Action: promote item (ambient -> next -> now)
    ctx.actions.register("promote-item", async (params) => {
      const itemId = params.itemId as string;
      const queue = await getQueue(ctx);
      const item = queue.find((i) => i.id === itemId);
      if (!item) return { error: "Item not found" };

      if (item.priority === "ambient") item.priority = "next";
      else if (item.priority === "next") item.priority = "now";

      await saveQueue(ctx, queue);
      return { promoted: true, newPriority: item.priority };
    });

    // Event listeners for attention pipeline
    const watchedEvents = [
      "approval.created",
      "agent.run.failed",
      "agent.run.finished",
      "cost_event.created",
      "approval.decided",
      "activity.logged",
    ] as const;

    for (const eventType of watchedEvents) {
      ctx.events.on(eventType, async (event) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const priority = classifyEvent(eventType, payload);

        const title =
          (payload.title as string) ??
          (payload.summary as string) ??
          `${eventType} event`;

        await addItem(ctx, {
          priority,
          title,
          source: (payload.agentId as string) ?? "system",
          sourceEvent: eventType,
          agentId: payload.agentId as string | undefined,
          metadata: payload,
        });

        ctx.logger.info(
          `Aperture: ${eventType} -> ${priority}: ${title}`,
        );
      });
    }

    ctx.logger.info("Aperture Attention Manager ready");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) return { status: "error", message: "Plugin not initialized" };

    const queue = await getQueue(ctx);
    const nowCount = queue.filter((i) => i.priority === "now").length;
    return {
      status: nowCount > 10 ? "degraded" : "ok",
      message: `${queue.length} items in queue (${nowCount} urgent)`,
    };
  },

  async onValidateConfig(
    config: Record<string, unknown>,
  ): Promise<PluginConfigValidationResult> {
    return { ok: true };
  },

  async onShutdown() {
    currentContext?.logger.info("Aperture plugin shutting down");
  },
});

runWorker(plugin, import.meta.url);
