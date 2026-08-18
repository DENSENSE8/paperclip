import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { secretService } from "../services/index.js";

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";

export function githubOAuthRoutes(db: Db) {
  const router = Router();
  const secrets = secretService(db);

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
      // Decode state
      const stateData = JSON.parse(Buffer.from(state as string, "base64").toString());
      const { companyId, userId } = stateData;

      // Exchange code for access token
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

      // Store token as company secret
      const existingSecret = await secrets.getByName(companyId, "GITHUB_OAUTH_TOKEN");

      if (existingSecret) {
        // Update existing secret with new token
        await secrets.rotate(
          existingSecret.id,
          { value: tokenData.access_token },
          { userId },
        );
      } else {
        // Create new secret
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

      // Redirect back to company settings
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

    const secret = await secrets.getByName(companyId, "GITHUB_OAUTH_TOKEN");
    res.json({ connected: !!secret });
  });

  return router;
}
