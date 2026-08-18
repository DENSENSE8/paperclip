import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import { eq, and, sql } from "drizzle-orm";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  companyPortabilityService,
  companyService,
  logActivity,
  projectService,
  secretService,
} from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  getGitHubToken,
  getGitHubTokenForCompany,
  listGitHubRepos,
  buildAuthenticatedCloneUrl,
  type GitHubRepo,
} from "../services/github.js";

export function companyRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = companyService(db);
  const agents = agentService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const projects = projectService(db);

  async function assertCanUpdateBranding(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can update company branding");
    }
  }

  async function assertCanManagePortability(req: Request, companyId: string, capability: "imports" | "exports") {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage company ${capability}`);
    }
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Allow agents (CEO) to read their own company; board always allowed
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    assertBoard(req);
    if (req.body.target.mode === "existing_company") {
      assertCompanyAccess(req, req.body.target.companyId);
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    assertBoard(req);
    if (req.body.target.mode === "existing_company") {
      assertCompanyAccess(req, req.body.target.companyId);
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/:companyId/exports/preview", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const preview = await portability.previewExport(companyId, req.body);
    res.json(preview);
  });

  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(req.body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", validate(companyPortabilityImportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.imported",
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const company = await svc.create(req.body);
    await access.ensureMembership(company.id, "user", req.actor.userId ?? "local-board", "owner", "active");
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    res.status(201).json(company);
  });

  router.patch("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      // Only CEO agents may update company branding fields
      const agentSvc = agentService(db);
      const actorAgent = req.actor.agentId ? await agentSvc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents or board users may update company settings");
      }
      if (actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      body = updateCompanyBrandingSchema.parse(req.body);
    } else {
      assertBoard(req);
      body = updateCompanySchema.parse(req.body);
    }

    const company = await svc.update(companyId, body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.patch("/:companyId/branding", validate(updateCompanyBrandingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanUpdateBranding(req, companyId);
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  // ── GitHub Repository Connections ──────────────────────────────────────

  router.get("/:companyId/github/repos", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const token = await getGitHubTokenForCompany(db, companyId);
    if (!token) {
      res.json({ repos: [], connected: [], tokenConfigured: false });
      return;
    }

    const [repos, connectedRows] = await Promise.all([
      listGitHubRepos(token),
      db
        .select({ metadata: projectWorkspaces.metadata })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, companyId),
            sql`${projectWorkspaces.metadata}->>'source' = 'github_company_connection'`,
          ),
        ),
    ]);

    const connected = connectedRows
      .map((row) => (row.metadata as Record<string, unknown> | null)?.githubFullName as string)
      .filter(Boolean);

    res.json({ repos, connected, tokenConfigured: true });
  });

  router.post("/:companyId/github/repos", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const token = await getGitHubTokenForCompany(db, companyId);
    if (!token) {
      res.status(400).json({ error: "GitHub token is not configured" });
      return;
    }

    const { repos } = req.body as {
      repos: Array<{ fullName: string; cloneUrl: string; defaultBranch: string }>;
    };
    if (!Array.isArray(repos) || repos.length === 0) {
      res.status(400).json({ error: "repos array is required" });
      return;
    }

    const results: Array<{ fullName: string; projectId: string; workspaceId: string }> = [];

    for (const repo of repos) {
      // Check if workspace already exists for this repo
      const existing = await db
        .select({ id: projectWorkspaces.id })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, companyId),
            sql`${projectWorkspaces.metadata}->>'source' = 'github_company_connection'`,
            sql`${projectWorkspaces.metadata}->>'githubFullName' = ${repo.fullName}`,
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing) continue;

      // Find or create project
      const existingProjects = await projects.list(companyId);
      let project = existingProjects.find(
        (p) => (p.metadata as Record<string, unknown> | null)?.githubRepo === repo.fullName,
      );
      if (!project) {
        project = await projects.create(companyId, {
          name: repo.fullName,
          metadata: { githubRepo: repo.fullName },
        });
      }

      // Create workspace
      const authenticatedUrl = buildAuthenticatedCloneUrl(repo.cloneUrl, token);
      const workspace = await projects.createWorkspace(project.id, {
        sourceType: "git_repo",
        repoUrl: authenticatedUrl,
        repoRef: repo.defaultBranch,
        name: repo.fullName,
        isPrimary: true,
        metadata: {
          source: "github_company_connection",
          githubFullName: repo.fullName,
        },
      });

      if (workspace) {
        results.push({
          fullName: repo.fullName,
          projectId: project.id,
          workspaceId: workspace.id,
        });
      }
    }

    res.json({ connected: results });
  });

  router.delete("/:companyId/github/repos/:fullName", async (req, res) => {
    const companyId = req.params.companyId as string;
    const fullName = decodeURIComponent(req.params.fullName as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    // Find the workspace with this github connection
    const rows = await db
      .select({
        id: projectWorkspaces.id,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, companyId),
          sql`${projectWorkspaces.metadata}->>'source' = 'github_company_connection'`,
          sql`${projectWorkspaces.metadata}->>'githubFullName' = ${fullName}`,
        ),
      );

    if (rows.length === 0) {
      res.status(404).json({ error: "GitHub connection not found" });
      return;
    }

    for (const row of rows) {
      await projects.removeWorkspace(row.projectId, row.id);
    }

    res.json({ ok: true, disconnected: fullName });
  });

  // ── GitHub OAuth ──────────────────────────────────────────────────────

  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";

  // Initiate OAuth flow
  router.get("/:companyId/github/oauth/authorize", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    if (!GITHUB_CLIENT_ID) {
      res.status(400).json({ error: "GITHUB_CLIENT_ID not configured" });
      return;
    }

    const redirectUri = `${req.protocol}://${req.get("host")}/api/companies/${companyId}/github/oauth/callback`;
    const state = Buffer.from(JSON.stringify({ companyId, userId: req.actor.userId })).toString("base64");

    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "repo");
    authUrl.searchParams.set("state", state);

    res.redirect(authUrl.toString());
  });

  // Handle OAuth callback
  router.get("/:companyId/github/oauth/callback", async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    try {
      const stateData = JSON.parse(Buffer.from(state as string, "base64").toString());
      const { companyId, userId } = stateData;

      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };

      if (tokenData.error || !tokenData.access_token) {
        throw new Error(tokenData.error || "Failed to get access token");
      }

      const secrets = secretService(db);
      const existingSecret = await secrets.getByName(companyId, "GITHUB_OAUTH_TOKEN");

      if (existingSecret) {
        await secrets.rotate(existingSecret.id, { value: tokenData.access_token }, { userId });
      } else {
        await secrets.create(
          companyId,
          {
            name: "GITHUB_OAUTH_TOKEN",
            description: "GitHub OAuth token for repository access",
            provider: "local_encrypted",
            value: tokenData.access_token,
          },
          { userId },
        );
      }

      res.redirect(`/settings?github_connected=true`);
    } catch (error) {
      console.error("GitHub OAuth error:", error);
      res.status(500).send(`OAuth failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Disconnect GitHub
  router.delete("/:companyId/github/oauth", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const secrets = secretService(db);
    const secret = await secrets.getByName(companyId, "GITHUB_OAUTH_TOKEN");
    if (secret) {
      await secrets.remove(secret.id);
    }

    res.json({ ok: true });
  });

  // Check OAuth status
  router.get("/:companyId/github/oauth/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const secrets = secretService(db);
    const secret = await secrets.getByName(companyId, "GITHUB_OAUTH_TOKEN");
    res.json({ connected: !!secret });
  });

  return router;

}
