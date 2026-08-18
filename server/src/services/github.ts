import type { Db } from "@paperclipai/db";
import { secretService } from "./index.js";

export type GitHubRepo = {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
};

export function getGitHubToken(): string | null {
  const token = process.env.GITHUB_TOKEN?.trim();
  return token || null;
}

export async function getGitHubTokenForCompany(db: Db, companyId: string): Promise<string | null> {
  const secrets = secretService(db);

  // Try to get OAuth token from company secrets first
  const secret = await secrets.getByName(companyId, "GITHUB_OAUTH_TOKEN");
  if (secret) {
    try {
      const value = await secrets.resolveSecretValue(companyId, secret.id, "latest");
      if (value) return value;
    } catch {
      // Fall through to env var
    }
  }

  // Fall back to environment variable
  return getGitHubToken();
}

export function buildAuthenticatedCloneUrl(cloneUrl: string, token: string): string {
  const url = new URL(cloneUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

function mapRepo(raw: Record<string, unknown>): GitHubRepo {
  return {
    fullName: raw.full_name as string,
    htmlUrl: raw.html_url as string,
    cloneUrl: raw.clone_url as string,
    defaultBranch: (raw.default_branch as string) ?? "main",
    private: raw.private as boolean,
    description: (raw.description as string) ?? null,
  };
}

export async function listGitHubRepos(token: string): Promise<GitHubRepo[]> {
  if (!token) return [];

  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= 2; page++) {
    const url = `https://api.github.com/user/repos?per_page=100&sort=updated&type=all&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      if (page === 1) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }
      break;
    }
    const data = (await response.json()) as Record<string, unknown>[];
    if (data.length === 0) break;
    repos.push(...data.map(mapRepo));
  }
  return repos;
}

export async function getGitHubRepo(fullName: string, token: string): Promise<GitHubRepo> {
  if (!token) throw new Error("GitHub token is required");

  const response = await fetch(`https://api.github.com/repos/${fullName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API error fetching ${fullName}: ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  return mapRepo(data);
}
