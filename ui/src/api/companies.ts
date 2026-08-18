import type {
  Company,
  CompanyPortabilityExportRequest,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
  UpdateCompanyBranding,
} from "@paperclipai/shared";
import { api } from "./client";

export type CompanyStats = Record<string, { agentCount: number; issueCount: number }>;

export type GitHubRepo = {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
};

export type GitHubReposResponse = {
  repos: GitHubRepo[];
  connected: string[];
  tokenConfigured: boolean;
};

export const companiesApi = {
  list: () => api.get<Company[]>("/companies"),
  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),
  stats: () => api.get<CompanyStats>("/companies/stats"),
  create: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) =>
    api.post<Company>("/companies", data),
  update: (
    companyId: string,
    data: Partial<
      Pick<
        Company,
        "name" | "description" | "status" | "budgetMonthlyCents" | "requireBoardApprovalForNewAgents" | "brandColor" | "logoAssetId"
      >
    >,
  ) => api.patch<Company>(`/companies/${companyId}`, data),
  updateBranding: (companyId: string, data: UpdateCompanyBranding) =>
    api.patch<Company>(`/companies/${companyId}/branding`, data),
  archive: (companyId: string) => api.post<Company>(`/companies/${companyId}/archive`, {}),
  remove: (companyId: string) => api.delete<{ ok: true }>(`/companies/${companyId}`),
  exportBundle: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/export`, data),
  exportPreview: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportPreviewResult>(`/companies/${companyId}/exports/preview`, data),
  exportPackage: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/exports`, data),
  importPreview: (data: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>("/companies/import/preview", data),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),

  // GitHub repository connections
  listGitHubRepos: (companyId: string) =>
    api.get<GitHubReposResponse>(`/companies/${companyId}/github/repos`),
  connectGitHubRepos: (companyId: string, repos: Array<{ fullName: string; cloneUrl: string; defaultBranch: string }>) =>
    api.post<{ connected: Array<{ fullName: string; projectId: string; workspaceId: string }> }>(
      `/companies/${companyId}/github/repos`,
      { repos },
    ),
  disconnectGitHubRepo: (companyId: string, fullName: string) =>
    api.delete<{ ok: true; disconnected: string }>(
      `/companies/${companyId}/github/repos/${encodeURIComponent(fullName)}`,
    ),

  // GitHub OAuth
  githubOAuthStatus: (companyId: string) =>
    api.get<{ connected: boolean }>(`/companies/${companyId}/github/oauth/status`),
  githubOAuthDisconnect: (companyId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/github/oauth`),
  // OAuth authorize is a redirect, handled via window.location
  githubOAuthAuthorizeUrl: (companyId: string) =>
    `/api/companies/${companyId}/github/oauth/authorize`,
};
