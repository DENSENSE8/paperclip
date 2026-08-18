import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginConfigValidationResult,
  type PluginWebhookInput,
  type Agent,
} from "@paperclipai/plugin-sdk";
import { MANIFEST } from "./manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LinearSyncConfig {
  linearApiKey: string;
  teamId: string;
  labelMap?: Record<string, string>;
  syncIntervalMinutes?: number;
  gsd2AgentName?: string;
  ceoAgentName?: string;
  gsd2Labels?: string[];
  quickLabels?: string[];
}

interface CompanyLinearConfig {
  linearApiKey: string;
  teamId: string;
  labelMap?: Record<string, string>;
  gsd2AgentName?: string;
  ceoAgentName?: string;
  gsd2Labels?: string[];
  quickLabels?: string[];
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  assignee?: { name: string };
  updatedAt: string;
}

interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Linear GraphQL helpers
// ---------------------------------------------------------------------------

const LINEAR_GQL = "https://api.linear.app/graphql";

async function linearQuery(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
  const data = (await res.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

async function linearMutation(
  apiKey: string,
  mutation: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });
  if (!res.ok) throw new Error(`Linear API mutation error: ${res.status}`);
  const data = (await res.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

// ---------------------------------------------------------------------------
// Status mapping: Paperclip status → Linear state name
// ---------------------------------------------------------------------------

const PAPERCLIP_TO_LINEAR_STATUS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let currentContext: PluginContext | null = null;

/** Linear teamId -> Paperclip companyId lookup */
const teamToCompany = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCompanyConfig(
  ctx: PluginContext,
  companyId: string,
): Promise<CompanyLinearConfig | null> {
  // Try company-scoped state first
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: "linear",
    stateKey: "config",
  });
  if (raw && typeof raw === "object" && (raw as CompanyLinearConfig).linearApiKey) {
    return raw as CompanyLinearConfig;
  }

  // Fall back to instance config
  const configRaw = await ctx.config.get();
  const config = configRaw as unknown as LinearSyncConfig | null;
  if (config?.linearApiKey && config?.teamId) {
    return {
      linearApiKey: config.linearApiKey,
      teamId: config.teamId,
      labelMap: config.labelMap,
      gsd2AgentName: config.gsd2AgentName,
      ceoAgentName: config.ceoAgentName,
      gsd2Labels: config.gsd2Labels,
      quickLabels: config.quickLabels,
    };
  }

  return null;
}

async function buildTeamLookup(ctx: PluginContext): Promise<void> {
  teamToCompany.clear();

  try {
    const companies = await ctx.companies.list();
    for (const company of companies) {
      const raw = await ctx.state.get({
        scopeKind: "company",
        scopeId: company.id,
        namespace: "linear",
        stateKey: "config",
      });
      if (raw && typeof raw === "object" && (raw as CompanyLinearConfig).teamId) {
        const cfg = raw as CompanyLinearConfig;
        teamToCompany.set(cfg.teamId, company.id);
        ctx.logger.debug(
          `Mapped team ${cfg.teamId} -> company ${company.id} (${company.name})`,
        );
      }
    }

    // Also log instance config as fallback awareness
    const instanceConfig = (await ctx.config.get()) as unknown as LinearSyncConfig | null;
    if (instanceConfig?.teamId && !teamToCompany.has(instanceConfig.teamId)) {
      ctx.logger.debug(
        `Instance config teamId ${instanceConfig.teamId} registered as fallback`,
      );
    }

    ctx.logger.info(`Team lookup built: ${teamToCompany.size} company mappings`);
  } catch (err) {
    ctx.logger.error(`Failed to build team lookup: ${err}`);
  }
}

async function resolveAgentByName(
  ctx: PluginContext,
  agentName: string,
  companyId: string,
): Promise<Agent | null> {
  const agents = await ctx.agents.list({ companyId });
  return agents.find((a) => a.name === agentName) ?? null;
}

// ---------------------------------------------------------------------------
// Linear workflow state map — cached per company
// ---------------------------------------------------------------------------

async function getOrFetchStateMap(
  ctx: PluginContext,
  companyId: string,
  config: CompanyLinearConfig,
): Promise<Record<string, string>> {
  // Check cached state map
  const cached = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: "linear",
    stateKey: "state-map",
  });
  if (cached && typeof cached === "object" && Object.keys(cached as Record<string, string>).length > 0) {
    return cached as Record<string, string>;
  }

  // Fetch from Linear
  const query = `
    query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type } }
      }
    }
  `;
  const data = (await linearQuery(config.linearApiKey, query, {
    teamId: config.teamId,
  })) as { team?: { states?: { nodes?: LinearWorkflowState[] } } };

  const states = data?.team?.states?.nodes ?? [];
  const stateMap: Record<string, string> = {};
  for (const s of states) {
    // Map by lowercase name for case-insensitive lookup
    stateMap[s.name.toLowerCase()] = s.id;
  }

  // Cache it
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: companyId,
      namespace: "linear",
      stateKey: "state-map",
    },
    stateMap,
  );

  ctx.logger.info(
    `Cached ${states.length} Linear workflow states for company ${companyId}`,
  );
  return stateMap;
}

function resolveLinearStateId(
  stateMap: Record<string, string>,
  paperclipStatus: string,
): string | null {
  const linearName = PAPERCLIP_TO_LINEAR_STATUS[paperclipStatus];
  if (!linearName) return null;
  // Try exact match first, then case-insensitive
  return stateMap[linearName.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Bidirectional ID mapping helpers
// ---------------------------------------------------------------------------

async function storeBidirectionalMapping(
  ctx: PluginContext,
  companyId: string | undefined,
  paperclipIssueId: string,
  linearIssueId: string,
): Promise<void> {
  const scopeBase = companyId
    ? { scopeKind: "company" as const, scopeId: companyId, namespace: "linear" }
    : { scopeKind: "instance" as const };

  // Paperclip → Linear
  await ctx.state.set(
    { ...scopeBase, stateKey: `paperclip-to-linear-${paperclipIssueId}` },
    linearIssueId,
  );

  // Linear → Paperclip
  await ctx.state.set(
    { ...scopeBase, stateKey: `linear-to-paperclip-${linearIssueId}` },
    paperclipIssueId,
  );
}

async function getLinearIdForPaperclip(
  ctx: PluginContext,
  companyId: string | undefined,
  paperclipIssueId: string,
): Promise<string | null> {
  const scopeBase = companyId
    ? { scopeKind: "company" as const, scopeId: companyId, namespace: "linear" }
    : { scopeKind: "instance" as const };

  const linearId = await ctx.state.get({
    ...scopeBase,
    stateKey: `paperclip-to-linear-${paperclipIssueId}`,
  });
  return (linearId as string) ?? null;
}

// ---------------------------------------------------------------------------
// Write-back: Paperclip → Linear
// ---------------------------------------------------------------------------

async function writeBackStatusToLinear(
  ctx: PluginContext,
  companyId: string,
  paperclipIssueId: string,
  newStatus: string,
): Promise<void> {
  const config = await getCompanyConfig(ctx, companyId);
  if (!config?.linearApiKey) return;

  const linearIssueId = await getLinearIdForPaperclip(ctx, companyId, paperclipIssueId);
  if (!linearIssueId) {
    ctx.logger.debug(
      `No Linear mapping for Paperclip issue ${paperclipIssueId} — skipping write-back`,
    );
    return;
  }

  const stateMap = await getOrFetchStateMap(ctx, companyId, config);
  const linearStateId = resolveLinearStateId(stateMap, newStatus);
  if (!linearStateId) {
    ctx.logger.debug(
      `No Linear state mapping for Paperclip status "${newStatus}" — skipping write-back`,
    );
    return;
  }

  const mutation = `
    mutation UpdateIssue($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
        issue { id identifier state { name } }
      }
    }
  `;

  try {
    const result = (await linearMutation(config.linearApiKey, mutation, {
      issueId: linearIssueId,
      stateId: linearStateId,
    })) as { issueUpdate?: { success: boolean; issue?: { identifier: string; state: { name: string } } } };

    if (result?.issueUpdate?.success) {
      ctx.logger.info(
        `Write-back: Paperclip ${paperclipIssueId} → Linear ${result.issueUpdate.issue?.identifier} status="${result.issueUpdate.issue?.state?.name}"`,
      );
    } else {
      ctx.logger.warn(
        `Write-back failed for Paperclip ${paperclipIssueId} → Linear ${linearIssueId}`,
      );
    }
  } catch (err) {
    ctx.logger.error(`Write-back error: ${err}`);
  }
}

async function writeBackCommentToLinear(
  ctx: PluginContext,
  companyId: string,
  paperclipIssueId: string,
  commentBody: string,
): Promise<void> {
  const config = await getCompanyConfig(ctx, companyId);
  if (!config?.linearApiKey) return;

  const linearIssueId = await getLinearIdForPaperclip(ctx, companyId, paperclipIssueId);
  if (!linearIssueId) {
    ctx.logger.debug(
      `No Linear mapping for Paperclip issue ${paperclipIssueId} — skipping comment sync`,
    );
    return;
  }

  const mutation = `
    mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id }
      }
    }
  `;

  try {
    const result = (await linearMutation(config.linearApiKey, mutation, {
      issueId: linearIssueId,
      body: `[Agent] ${commentBody}`,
    })) as { commentCreate?: { success: boolean; comment?: { id: string } } };

    if (result?.commentCreate?.success) {
      ctx.logger.info(
        `Comment sync: Paperclip ${paperclipIssueId} → Linear ${linearIssueId} (comment ${result.commentCreate.comment?.id})`,
      );
    }
  } catch (err) {
    ctx.logger.error(`Comment sync error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Per-company sync
// ---------------------------------------------------------------------------

async function syncCompanyFromLinear(
  ctx: PluginContext,
  companyId: string,
): Promise<void> {
  const config = await getCompanyConfig(ctx, companyId);
  if (!config?.linearApiKey || !config?.teamId) {
    ctx.logger.debug(`Skipping sync for company ${companyId}: missing config`);
    return;
  }

  const lastSyncRaw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: "linear",
    stateKey: "sync-cursor",
  });
  const lastSync =
    (lastSyncRaw as string) ?? new Date(Date.now() - 3600_000).toISOString();

  try {
    const query = `
      query RecentIssues($teamId: String!, $after: DateTime!) {
        team(id: $teamId) {
          issues(filter: { updatedAt: { gt: $after } }, first: 50, orderBy: updatedAt) {
            nodes {
              id identifier title description priority
              state { name }
              labels { nodes { name } }
              updatedAt
            }
          }
        }
      }
    `;
    const data = (await linearQuery(config.linearApiKey, query, {
      teamId: config.teamId,
      after: lastSync,
    })) as { team?: { issues?: { nodes?: LinearIssue[] } } };

    const issues = data?.team?.issues?.nodes ?? [];
    ctx.logger.info(
      `Linear sync (company ${companyId}): ${issues.length} issues updated since ${lastSync}`,
    );

    const totalRaw = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      namespace: "linear",
      stateKey: "total-synced",
    });
    const total = (typeof totalRaw === "number" ? totalRaw : 0) + issues.length;

    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "linear", stateKey: "total-synced" },
      total,
    );
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "linear", stateKey: "last-sync-time" },
      new Date().toISOString(),
    );
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "linear", stateKey: "sync-cursor" },
      new Date().toISOString(),
    );
  } catch (err) {
    ctx.logger.error(`Linear sync failed for company ${companyId}: ${err}`);
  }
}

async function syncFromLinearLegacy(ctx: PluginContext): Promise<void> {
  const configRaw = await ctx.config.get();
  const config = configRaw as unknown as LinearSyncConfig | null;
  if (!config?.linearApiKey || !config?.teamId) {
    ctx.logger.info("Skipping legacy sync: missing Linear config");
    return;
  }

  const lastSyncRaw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: "last-sync-cursor",
  });
  const lastSync =
    (lastSyncRaw as string) ?? new Date(Date.now() - 3600_000).toISOString();

  try {
    const query = `
      query RecentIssues($teamId: String!, $after: DateTime!) {
        team(id: $teamId) {
          issues(filter: { updatedAt: { gt: $after } }, first: 50, orderBy: updatedAt) {
            nodes {
              id identifier title description priority
              state { name }
              labels { nodes { name } }
              updatedAt
            }
          }
        }
      }
    `;
    const data = (await linearQuery(config.linearApiKey, query, {
      teamId: config.teamId,
      after: lastSync,
    })) as { team?: { issues?: { nodes?: LinearIssue[] } } };

    const issues = data?.team?.issues?.nodes ?? [];
    ctx.logger.info(`Legacy sync: ${issues.length} issues updated since ${lastSync}`);

    const totalRaw = await ctx.state.get({
      scopeKind: "instance",
      stateKey: "total-synced",
    });
    const total = (typeof totalRaw === "number" ? totalRaw : 0) + issues.length;

    await ctx.state.set(
      { scopeKind: "instance", stateKey: "total-synced" },
      total,
    );
    await ctx.state.set(
      { scopeKind: "instance", stateKey: "last-sync-time" },
      new Date().toISOString(),
    );
    await ctx.state.set(
      { scopeKind: "instance", stateKey: "last-sync-cursor" },
      new Date().toISOString(),
    );
  } catch (err) {
    ctx.logger.error(`Legacy sync failed: ${err}`);
  }
}

async function syncAllCompanies(ctx: PluginContext): Promise<void> {
  if (teamToCompany.size === 0) {
    // No per-company configs: fall back to legacy instance-scoped sync
    await syncFromLinearLegacy(ctx);
    return;
  }

  const companyIds = new Set(teamToCompany.values());
  for (const companyId of companyIds) {
    await syncCompanyFromLinear(ctx, companyId);
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    currentContext = ctx;
    ctx.logger.info("Linear Sync plugin starting (multi-tenant, bidirectional)...");

    // Build team -> company lookup
    await buildTeamLookup(ctx);

    // Pre-cache workflow state maps for all known companies
    for (const [, companyId] of teamToCompany) {
      try {
        const config = await getCompanyConfig(ctx, companyId);
        if (config) await getOrFetchStateMap(ctx, companyId, config);
      } catch (err) {
        ctx.logger.warn(`Failed to pre-cache state map for company ${companyId}: ${err}`);
      }
    }

    // Event listeners
    ctx.events.on("issue.created", async (event) => {
      const payload = event.payload as Record<string, unknown>;
      ctx.logger.info(`Issue created: ${payload?.title ?? "unknown"}`);

      // Complete bidirectional mapping when a Paperclip issue is created with originKind=linear
      const originKind = payload?.originKind as string | undefined;
      const originId = payload?.originId as string | undefined;
      const paperclipIssueId = payload?.id as string | undefined;
      const issueCompanyId = payload?.companyId as string | undefined;

      if (originKind === "linear" && originId && paperclipIssueId && issueCompanyId) {
        await storeBidirectionalMapping(ctx, issueCompanyId, paperclipIssueId, originId);
        ctx.logger.info(
          `Bidirectional mapping stored: Paperclip ${paperclipIssueId} <-> Linear ${originId}`,
        );
      }
    });

    ctx.events.on("issue.updated", async (event) => {
      const payload = event.payload as Record<string, unknown>;
      const issueId = payload?.id as string | undefined;
      const newStatus = payload?.status as string | undefined;
      const originKind = payload?.originKind as string | undefined;
      const companyId = payload?.companyId as string | undefined;

      ctx.logger.info(`Issue updated: ${issueId ?? "unknown"} status=${newStatus ?? "?"}`);

      // Skip if this update originated from Linear (prevents sync loops)
      if (originKind === "linear") {
        ctx.logger.debug(`Skipping write-back for ${issueId}: originKind=linear`);
        return;
      }

      // Write back status change to Linear if we have a mapping
      if (issueId && newStatus && companyId) {
        await writeBackStatusToLinear(ctx, companyId, issueId, newStatus);
      }
    });

    // Comment sync: Paperclip → Linear
    ctx.events.on("issue.comment.created", async (event) => {
      const payload = event.payload as Record<string, unknown>;
      const issueId = payload?.issueId as string | undefined;
      const body = payload?.body as string | undefined;
      const companyId = payload?.companyId as string | undefined;
      const authorKind = payload?.authorKind as string | undefined;

      // Only sync agent comments (not human comments echoed back)
      if (authorKind !== "agent") return;

      if (issueId && body && companyId) {
        await writeBackCommentToLinear(ctx, companyId, issueId, body);
      }
    });

    // -------------------------------------------------------------------
    // Data handlers
    // -------------------------------------------------------------------

    ctx.data.register("sync-status", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (companyId) {
        const lastSync = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          namespace: "linear",
          stateKey: "last-sync-time",
        });
        const syncCount = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          namespace: "linear",
          stateKey: "total-synced",
        });
        return {
          lastSyncTime: lastSync ?? null,
          totalSynced: syncCount ?? 0,
        };
      }
      // Legacy fallback
      const lastSync = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "last-sync-time",
      });
      const syncCount = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "total-synced",
      });
      return {
        lastSyncTime: lastSync ?? null,
        totalSynced: syncCount ?? 0,
      };
    });

    ctx.data.register("recent-synced", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (companyId) {
        const recent = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          namespace: "linear",
          stateKey: "recent-issues",
        });
        return recent ?? [];
      }
      // Legacy fallback
      const recent = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "recent-synced-issues",
      });
      return recent ?? [];
    });

    ctx.data.register("company-config", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return { error: "companyId required" };

      const config = await getCompanyConfig(ctx, companyId);
      if (!config) return { configured: false };

      return {
        configured: true,
        teamId: config.teamId,
        hasApiKey: !!config.linearApiKey,
        linearApiKey: config.linearApiKey
          ? "***" + config.linearApiKey.slice(-4)
          : null,
        gsd2AgentName: config.gsd2AgentName ?? null,
        ceoAgentName: config.ceoAgentName ?? null,
        gsd2Labels: config.gsd2Labels ?? [],
        quickLabels: config.quickLabels ?? [],
        labelMap: config.labelMap ?? {},
      };
    });

    ctx.data.register("all-company-configs", async () => {
      const companies = await ctx.companies.list();
      const results: Array<{
        companyId: string;
        companyName: string;
        teamId: string | null;
        configured: boolean;
      }> = [];

      for (const company of companies) {
        const config = await getCompanyConfig(ctx, company.id);
        results.push({
          companyId: company.id,
          companyName: company.name,
          teamId: config?.teamId ?? null,
          configured: !!config?.linearApiKey,
        });
      }

      return {
        companies: results,
        totalMapped: teamToCompany.size,
      };
    });

    // -------------------------------------------------------------------
    // Action handlers
    // -------------------------------------------------------------------

    ctx.actions.register("save-company-config", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return { error: "companyId required" };

      const config: CompanyLinearConfig = {
        linearApiKey: params.linearApiKey as string,
        teamId: params.teamId as string,
        labelMap: (params.labelMap as Record<string, string>) ?? undefined,
        gsd2AgentName: (params.gsd2AgentName as string) ?? undefined,
        ceoAgentName: (params.ceoAgentName as string) ?? undefined,
        gsd2Labels: (params.gsd2Labels as string[]) ?? undefined,
        quickLabels: (params.quickLabels as string[]) ?? undefined,
      };

      if (!config.linearApiKey || !config.teamId) {
        return { error: "linearApiKey and teamId are required" };
      }

      await ctx.state.set(
        {
          scopeKind: "company",
          scopeId: companyId,
          namespace: "linear",
          stateKey: "config",
        },
        config,
      );

      // Rebuild lookup
      await buildTeamLookup(ctx);

      // Pre-cache state map for new config
      try {
        await getOrFetchStateMap(ctx, companyId, config);
      } catch (err) {
        ctx.logger.warn(`Failed to cache state map for company ${companyId}: ${err}`);
      }

      ctx.logger.info(
        `Saved Linear config for company ${companyId} (team ${config.teamId})`,
      );
      return { success: true };
    });

    ctx.actions.register("trigger-sync", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (companyId) {
        ctx.logger.info(`Manual sync triggered for company ${companyId}`);
        await syncCompanyFromLinear(ctx, companyId);
      } else {
        ctx.logger.info("Manual sync triggered (all companies)");
        await syncAllCompanies(ctx);
      }
      return { success: true };
    });

    ctx.actions.register("refresh-state-map", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return { error: "companyId required" };

      const config = await getCompanyConfig(ctx, companyId);
      if (!config) return { error: "No config for company" };

      // Clear cached map to force re-fetch
      await ctx.state.set(
        {
          scopeKind: "company",
          scopeId: companyId,
          namespace: "linear",
          stateKey: "state-map",
        },
        {},
      );

      const stateMap = await getOrFetchStateMap(ctx, companyId, config);
      return { success: true, states: Object.keys(stateMap).length };
    });

    ctx.actions.register("search-linear", async (params) => {
      const companyId = params.companyId as string | undefined;
      let config: CompanyLinearConfig | null = null;

      if (companyId) {
        config = await getCompanyConfig(ctx, companyId);
      } else {
        const configRaw = await ctx.config.get();
        const legacy = configRaw as unknown as LinearSyncConfig | null;
        if (legacy?.linearApiKey) config = legacy;
      }

      if (!config?.linearApiKey)
        return { error: "Linear API key not configured" };

      const query = `
        query SearchIssues($teamId: String!, $filter: IssueFilter) {
          team(id: $teamId) {
            issues(filter: $filter, first: 20, orderBy: updatedAt) {
              nodes {
                id identifier title priority
                state { name }
                labels { nodes { name } }
                assignee { name }
                updatedAt
              }
            }
          }
        }
      `;
      const data = await linearQuery(config.linearApiKey, query, {
        teamId: config.teamId,
        filter: params?.filter ?? {},
      });
      return data;
    });

    // -------------------------------------------------------------------
    // Job: periodic sync
    // -------------------------------------------------------------------

    ctx.jobs.register("sync-linear-issues", async () => {
      ctx.logger.info("Running scheduled Linear sync...");
      await syncAllCompanies(ctx);
    });

    ctx.logger.info(
      `Linear Sync plugin ready (${teamToCompany.size} team mappings, bidirectional sync enabled)`,
    );
  },

  // -------------------------------------------------------------------
  // Webhook handler — routes by teamId -> companyId
  // -------------------------------------------------------------------

  async onWebhook(input: PluginWebhookInput) {
    const ctx = currentContext;
    if (!ctx) return;

    const payload = input.parsedBody as Record<string, unknown> | undefined;
    if (!payload) return;

    const action = payload.action as string;
    const type = payload.type as string;
    ctx.logger.info(`Linear webhook: ${type}.${action}`);

    if (type !== "Issue") return;

    const issueData = payload.data as Record<string, unknown>;
    if (!issueData) return;

    // Extract teamId from webhook payload
    const teamData = issueData.team as Record<string, unknown> | undefined;
    const webhookTeamId =
      (teamData?.id as string) ?? (issueData.teamId as string);

    // Resolve companyId from teamId lookup
    let companyId: string | undefined;
    let config: CompanyLinearConfig | null = null;

    if (webhookTeamId && teamToCompany.has(webhookTeamId)) {
      companyId = teamToCompany.get(webhookTeamId)!;
      config = await getCompanyConfig(ctx, companyId);
      ctx.logger.info(
        `Webhook routed: team ${webhookTeamId} -> company ${companyId}`,
      );
    } else {
      // Fallback to instance config (backward compat)
      const configRaw = await ctx.config.get();
      config = configRaw as unknown as LinearSyncConfig | null;
      if (!config?.linearApiKey) {
        ctx.logger.warn(
          `Webhook from unknown team ${webhookTeamId} and no instance config`,
        );
        return;
      }
      ctx.logger.info(
        `Webhook from team ${webhookTeamId} using instance config fallback`,
      );
    }

    if (!config) return;

    const labels = (issueData.labels as Array<{ name: string }>) ?? [];

    if (action === "create" || action === "update") {
      // 3-tier label routing: labelMap -> gsd2Labels -> quickLabels
      const labelMap = config.labelMap ?? {};
      const gsd2Labels = config.gsd2Labels ?? [
        "large-feature",
        "refactor",
        "milestone",
        "spec-driven",
      ];
      const quickLabels = config.quickLabels ?? [
        "quick-fix",
        "small",
        "bug",
        "chore",
      ];
      const issueLabels = labels.map((l) => l.name);

      const matchedLabel = labels.find((l) => labelMap[l.name]);
      let routedAgent = matchedLabel
        ? labelMap[matchedLabel.name]
        : undefined;
      let routeReason = routedAgent
        ? `labelMap: ${matchedLabel!.name}`
        : "";

      if (!routedAgent) {
        const gsd2Match = issueLabels.find((l) => gsd2Labels.includes(l));
        if (gsd2Match && config.gsd2AgentName) {
          routedAgent = config.gsd2AgentName;
          routeReason = `gsd2Label: ${gsd2Match}`;
        }
      }

      if (!routedAgent) {
        const quickMatch = issueLabels.find((l) => quickLabels.includes(l));
        if (quickMatch && config.ceoAgentName) {
          routedAgent = config.ceoAgentName;
          routeReason = `quickLabel: ${quickMatch}`;
        }
      }

      // Store recent issue — company-scoped if we have companyId, else instance
      const scopeKey = companyId
        ? {
            scopeKind: "company" as const,
            scopeId: companyId,
            namespace: "linear",
            stateKey: "recent-issues",
          }
        : {
            scopeKind: "instance" as const,
            stateKey: "recent-synced-issues",
          };

      const recentRaw = await ctx.state.get(scopeKey);
      const recent = (
        Array.isArray(recentRaw) ? recentRaw : []
      ) as Array<Record<string, unknown>>;

      recent.unshift({
        linearId: issueData.id,
        title: issueData.title,
        action,
        agentName: routedAgent ?? null,
        routeReason: routeReason || null,
        syncedAt: new Date().toISOString(),
      });
      if (recent.length > 50) recent.length = 50;
      await ctx.state.set(scopeKey, recent);

      if (routedAgent) {
        ctx.logger.info(
          `Routed issue to "${routedAgent}" (${routeReason})`,
        );

        // Store Linear metadata
        const metaScopeKey = companyId
          ? {
              scopeKind: "company" as const,
              scopeId: companyId,
              namespace: "linear",
              stateKey: `issue-${issueData.id as string}`,
            }
          : {
              scopeKind: "instance" as const,
              stateKey: `linear-issue-${issueData.id as string}`,
            };

        await ctx.state.set(metaScopeKey, {
          linearId: issueData.id,
          linearIdentifier: issueData.identifier,
          title: issueData.title,
          description: issueData.description,
          syncSource: "linear-webhook",
          agentName: routedAgent,
          routeReason,
        });

        // Invoke agent — resolve by name within company, use 3-arg form
        try {
          if (companyId) {
            const agent = await resolveAgentByName(
              ctx,
              routedAgent,
              companyId,
            );
            if (agent) {
              await ctx.agents.invoke(agent.id, companyId, {
                prompt: `Linear issue ${issueData.identifier}: ${issueData.title}\n\n${issueData.description ?? ""}`,
                reason: `Linear webhook ${action} (${routeReason})`,
              });
              ctx.logger.info(
                `Invoked agent "${routedAgent}" (id: ${agent.id}) for ${issueData.identifier}`,
              );

              // Store bidirectional mapping using Linear ID and the agent invocation
              // The Paperclip issue ID comes back when the agent creates it via originKind/originId.
              // For now, store the Linear→agent mapping so we can complete the bidirectional
              // mapping when the Paperclip issue is created with originId = linearIssueId.
              // We store a "pending" mapping keyed by Linear ID for later resolution.
              await ctx.state.set(
                {
                  ...(companyId
                    ? { scopeKind: "company" as const, scopeId: companyId, namespace: "linear" }
                    : { scopeKind: "instance" as const }),
                  stateKey: `pending-map-${issueData.id as string}`,
                },
                {
                  linearId: issueData.id,
                  linearIdentifier: issueData.identifier,
                  agentId: agent.id,
                  agentName: routedAgent,
                  createdAt: new Date().toISOString(),
                },
              );
            } else {
              ctx.logger.warn(
                `Agent "${routedAgent}" not found in company ${companyId}`,
              );
            }
          } else {
            // Legacy: no companyId, skip invoke
            ctx.logger.warn(
              `Cannot invoke agent without companyId — skipping invoke for "${routedAgent}"`,
            );
          }
        } catch (invokeErr) {
          ctx.logger.warn(
            `Could not invoke agent "${routedAgent}": ${invokeErr}`,
          );
        }
      }
    }

    // When a Paperclip issue is created with originKind=linear, complete the bidirectional mapping
    if (action === "create") {
      // This runs for Linear webhook creates — but we also need to handle
      // the Paperclip side. We listen for issue.created events above to
      // complete the mapping when originKind=linear and originId is set.
    }
  },

  // -------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) return { status: "error", message: "Plugin not initialized" };

    const mappedTeams = teamToCompany.size;

    // Spot-check: try the first mapped team's API connectivity
    if (mappedTeams > 0) {
      const firstEntry = teamToCompany.values().next();
      const firstCompanyId = firstEntry.value as string;
      const config = await getCompanyConfig(ctx, firstCompanyId);
      if (config?.linearApiKey) {
        try {
          await linearQuery(config.linearApiKey, "{ viewer { id name } }");
          return {
            status: "ok",
            message: `Linear API reachable (${mappedTeams} team mapping${mappedTeams !== 1 ? "s" : ""}, bidirectional sync)`,
          };
        } catch {
          return {
            status: "degraded",
            message: `Linear API unreachable (${mappedTeams} team mapping${mappedTeams !== 1 ? "s" : ""})`,
          };
        }
      }
    }

    // Fallback to instance config check
    const configRaw = await ctx.config.get();
    const config = configRaw as unknown as LinearSyncConfig | null;
    if (!config?.linearApiKey) {
      if (mappedTeams === 0) {
        return {
          status: "degraded",
          message:
            "No Linear API key configured (instance or per-company)",
        };
      }
      return {
        status: "ok",
        message: `${mappedTeams} team mapping${mappedTeams !== 1 ? "s" : ""} (no instance config)`,
      };
    }

    try {
      await linearQuery(config.linearApiKey, "{ viewer { id name } }");
      return {
        status: "ok",
        message: "Linear API reachable (instance config, bidirectional sync)",
      };
    } catch {
      return {
        status: "degraded",
        message: "Linear API unreachable (instance config)",
      };
    }
  },

  // -------------------------------------------------------------------
  // Config change handler
  // -------------------------------------------------------------------

  async onConfigChanged(): Promise<void> {
    const ctx = currentContext;
    if (!ctx) return;
    ctx.logger.info("Config changed, rebuilding team lookup...");
    await buildTeamLookup(ctx);
  },

  // -------------------------------------------------------------------
  // Config validation — relaxed: instance config optional
  // -------------------------------------------------------------------

  async onValidateConfig(
    config: Record<string, unknown>,
  ): Promise<PluginConfigValidationResult> {
    // Instance config is no longer required — per-company configs may exist
    const errors: string[] = [];

    if (config.linearApiKey && typeof config.linearApiKey !== "string") {
      errors.push("Linear API key must be a string");
    }
    if (config.teamId && typeof config.teamId !== "string") {
      errors.push("Linear Team ID must be a string");
    }
    // If one is set, both should be set
    if (config.linearApiKey && !config.teamId) {
      errors.push("Linear Team ID is required when API key is set");
    }
    if (config.teamId && !config.linearApiKey) {
      errors.push("Linear API key is required when Team ID is set");
    }

    return {
      ok: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  },

  async onShutdown() {
    currentContext?.logger.info("Linear Sync plugin shutting down");
    teamToCompany.clear();
  },
});

runWorker(plugin, import.meta.url);
