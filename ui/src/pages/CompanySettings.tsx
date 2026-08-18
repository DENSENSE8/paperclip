import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi, type GitHubRepo } from "../api/companies";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Settings, Download, Upload, Github } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import {
  Field,
  ToggleField
} from "../components/agent-config-primitives";

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  // Local repo path state
  const [localRepoPath, setLocalRepoPath] = useState("");
  const [localRepoName, setLocalRepoName] = useState("");

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  // ── GitHub OAuth ───────────────────────────────────────────────────────
  const oauthStatusQuery = useQuery({
    queryKey: ["github-oauth-status", selectedCompanyId],
    queryFn: () => companiesApi.githubOAuthStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const oauthDisconnectMutation = useMutation({
    mutationFn: () => companiesApi.githubOAuthDisconnect(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-oauth-status", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.githubRepos(selectedCompanyId!) });
    },
  });

  // ── GitHub Repos ───────────────────────────────────────────────────────
  const githubQuery = useQuery({
    queryKey: queryKeys.companies.githubRepos(selectedCompanyId ?? ""),
    queryFn: () => companiesApi.listGitHubRepos(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!oauthStatusQuery.data?.connected,
    staleTime: 60_000,
  });

  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [githubInitialized, setGithubInitialized] = useState(false);

  useEffect(() => {
    if (githubQuery.data && !githubInitialized) {
      setSelectedRepos(new Set(githubQuery.data.connected));
      setGithubInitialized(true);
    }
  }, [githubQuery.data, githubInitialized]);

  // Reset when company changes
  useEffect(() => {
    setGithubInitialized(false);
    setSelectedRepos(new Set());
  }, [selectedCompanyId]);

  const githubDirty = useMemo(() => {
    if (!githubQuery.data) return false;
    const current = new Set(githubQuery.data.connected);
    if (selectedRepos.size !== current.size) return true;
    for (const name of selectedRepos) {
      if (!current.has(name)) return true;
    }
    return false;
  }, [selectedRepos, githubQuery.data]);

  const githubSaveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !githubQuery.data) return;
      const current = new Set(githubQuery.data.connected);

      const toConnect = githubQuery.data.repos.filter(
        (r) => selectedRepos.has(r.fullName) && !current.has(r.fullName),
      );
      const toDisconnect = githubQuery.data.connected.filter(
        (name) => !selectedRepos.has(name),
      );

      if (toConnect.length > 0) {
        await companiesApi.connectGitHubRepos(
          selectedCompanyId,
          toConnect.map((r) => ({
            fullName: r.fullName,
            cloneUrl: r.cloneUrl,
            defaultBranch: r.defaultBranch,
          })),
        );
      }

      for (const name of toDisconnect) {
        await companiesApi.disconnectGitHubRepo(selectedCompanyId, name);
      }
    },
    onSuccess: () => {
      setGithubInitialized(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companies.githubRepos(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(selectedCompanyId!),
      });
    },
  });

  function toggleRepo(fullName: string) {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) {
        next.delete(fullName);
      } else {
        next.add(fullName);
      }
      return next;
    });
  }

  // ── Local Repository ───────────────────────────────────────────────────
  const addLocalRepoMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !localRepoPath.trim()) {
        throw new Error("Company ID and repository path are required");
      }

      // Derive a project name from the path or use the provided name
      const pathSegments = localRepoPath.replace(/\\/g, "/").split("/").filter(Boolean);
      const defaultName = pathSegments[pathSegments.length - 1] || "Local Repository";
      const projectName = localRepoName.trim() || defaultName;

      // Create a new project for this local repo
      const project = await projectsApi.create(selectedCompanyId, {
        name: projectName,
        metadata: { localPath: localRepoPath },
      });

      // Create a workspace pointing to the local path
      await projectsApi.createWorkspace(
        project.id,
        {
          sourceType: "local_path",
          cwd: localRepoPath,
          name: projectName,
          isPrimary: true,
        },
        selectedCompanyId,
      );

      return project;
    },
    onSuccess: () => {
      setLocalRepoPath("");
      setLocalRepoName("");
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(selectedCompanyId!),
      });
    },
  });

  function handleAddLocalRepo(e: React.FormEvent) {
    e.preventDefault();
    if (!localRepoPath.trim()) return;
    addLocalRepoMutation.mutate();
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null
    });
  }

  return (
    <div className="max-w-3xl space-y-8 pb-16">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <Settings className="h-5 w-5 text-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Company Settings</h1>
          <p className="text-sm text-muted-foreground">Manage your company profile and preferences</p>
        </div>
      </div>

      {/* General */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">General</h2>
          <p className="text-xs text-muted-foreground">Basic information about your company</p>
        </div>
        <div className="space-y-4 rounded-lg border border-border bg-card px-5 py-5 shadow-sm">
          <Field label="Company name" hint="The display name for your company.">
            <input
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Corporation"
            />
          </Field>
          <Field
            label="Description"
            hint="Optional description shown in the company profile."
          >
            <textarea
              className="min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y"
              value={description}
              placeholder="A brief description of your company..."
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* Appearance */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Appearance</h2>
          <p className="text-xs text-muted-foreground">Customize your company's visual identity</p>
        </div>
        <div className="space-y-4 rounded-lg border border-border bg-card px-5 py-5 shadow-sm">
          <div className="flex items-start gap-6">
            <div className="shrink-0">
              <div className="relative group">
                <CompanyPatternIcon
                  companyName={companyName || selectedCompany.name}
                  logoUrl={logoUrl || null}
                  brandColor={brandColor || null}
                  className="rounded-2xl transition-transform group-hover:scale-105"
                />
                <div className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-background bg-green-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div className="flex-1 space-y-4">
              <Field
                label="Logo"
                hint="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image."
              >
                <div className="space-y-2.5">
                  <div className="relative">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      onChange={handleLogoFileChange}
                      className="w-full cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors file:mr-4 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary file:text-primary-foreground file:px-3 file:py-1.5 file:text-xs file:font-medium file:transition-colors hover:file:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                        className="transition-all hover:border-destructive hover:text-destructive"
                      >
                        {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
                      <span className="font-medium">Error:</span>
                      <span>
                        {logoUploadError ??
                          (logoUploadMutation.error instanceof Error
                            ? logoUploadMutation.error.message
                            : "Logo upload failed")}
                      </span>
                    </div>
                  )}
                  {clearLogoMutation.isError && (
                    <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
                      <span className="font-medium">Error:</span>
                      <span>{clearLogoMutation.error.message}</span>
                    </div>
                  )}
                  {logoUploadMutation.isPending && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      <span>Uploading logo...</span>
                    </div>
                  )}
                </div>
              </Field>
              <Field
                label="Brand color"
                hint="Sets the hue for the company icon. Leave empty for auto-generated color."
              >
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <input
                      type="color"
                      value={brandColor || "#6366f1"}
                      onChange={(e) => setBrandColor(e.target.value)}
                      className="h-10 w-10 cursor-pointer rounded-lg border border-input bg-background p-1 transition-all hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder="Auto"
                    className="w-32 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs hover:text-foreground"
                    >
                      Reset
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </section>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-5 py-4 shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-2">
          <div className="flex-1">
            <p className="text-sm font-medium">You have unsaved changes</p>
            <p className="text-xs text-muted-foreground">Save your changes to update the company profile</p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="default"
              onClick={handleSaveGeneral}
              disabled={generalMutation.isPending || !companyName.trim()}
              className="min-w-[100px] shadow-sm"
            >
              {generalMutation.isPending ? (
                <>
                  <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                  Saving...
                </>
              ) : (
                "Save changes"
              )}
            </Button>
            {generalMutation.isSuccess && (
              <div className="flex items-center gap-1.5 text-sm font-medium text-green-600 animate-in fade-in">
                <div className="h-1.5 w-1.5 rounded-full bg-green-600" />
                Saved
              </div>
            )}
            {generalMutation.isError && (
              <div className="max-w-xs rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {generalMutation.error instanceof Error
                    ? generalMutation.error.message
                    : "Failed to save"}
              </div>
            )}
          </div>
        </div>
      )}

      {/* GitHub Repositories */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">GitHub Repositories</h2>
          <p className="text-xs text-muted-foreground">Connect cloud repositories or add local paths</p>
        </div>

        {/* OAuth Connection Status */}
        <div className="rounded-lg border border-border bg-card px-5 py-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Github className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-medium">GitHub Account</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {oauthStatusQuery.data?.connected
                    ? "Connected - browse and select repositories below"
                    : "Connect to access your GitHub repositories"}
                </p>
              </div>
            </div>
            <div>
              {oauthStatusQuery.isLoading ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              ) : oauthStatusQuery.data?.connected ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => oauthDisconnectMutation.mutate()}
                  disabled={oauthDisconnectMutation.isPending}
                  className="transition-colors hover:border-destructive hover:text-destructive"
                >
                  {oauthDisconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
                </Button>
              ) : (
                <Button
                  size="default"
                  onClick={() => {
                    window.location.href = companiesApi.githubOAuthAuthorizeUrl(selectedCompanyId!);
                  }}
                  className="shadow-sm"
                >
                  <Github className="mr-2 h-4 w-4" />
                  Connect GitHub
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Cloud Repositories (OAuth) */}
        {oauthStatusQuery.data?.connected && (
          <div className="rounded-lg border border-border bg-card px-5 py-5 shadow-sm">
            <h3 className="text-sm font-medium mb-3">Cloud Repositories</h3>
            {githubQuery.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <span>Loading repositories...</span>
              </div>
            ) : githubQuery.isError ? (
              <div className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
                Failed to load repositories: {githubQuery.error instanceof Error ? githubQuery.error.message : "Unknown error"}
              </div>
            ) : githubQuery.data?.repos.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No repositories found. Ensure your GitHub token has access to repositories.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="max-h-64 overflow-y-auto rounded-md border border-input">
                  {githubQuery.data?.repos.map((repo) => (
                    <label
                      key={repo.fullName}
                      className="flex items-start gap-3 p-3 hover:bg-muted/50 cursor-pointer border-b border-border last:border-b-0 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedRepos.has(repo.fullName)}
                        onChange={() => toggleRepo(repo.fullName)}
                        className="mt-0.5 h-4 w-4 rounded border-input"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{repo.fullName}</span>
                          {repo.private && (
                            <span className="shrink-0 text-[10px] bg-muted px-1.5 py-0.5 rounded font-medium">private</span>
                          )}
                        </div>
                        {repo.description && (
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">{repo.description}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="default"
                    onClick={() => githubSaveMutation.mutate()}
                    disabled={!githubDirty || githubSaveMutation.isPending}
                    className="shadow-sm"
                  >
                    {githubSaveMutation.isPending ? (
                      <>
                        <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                        Saving...
                      </>
                    ) : (
                      "Save changes"
                    )}
                  </Button>
                  {githubSaveMutation.isSuccess && (
                    <div className="flex items-center gap-1.5 text-sm font-medium text-green-600 animate-in fade-in">
                      <div className="h-1.5 w-1.5 rounded-full bg-green-600" />
                      Saved
                    </div>
                  )}
                  {githubSaveMutation.isError && (
                    <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {githubSaveMutation.error instanceof Error
                        ? githubSaveMutation.error.message
                        : "Failed to save"}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Local Repositories */}
        <div className="rounded-lg border border-border bg-card px-5 py-5 shadow-sm">
          <h3 className="text-sm font-medium mb-2">Local Repositories</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Add a repository that's already cloned on your local machine or network
          </p>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Repository Path
                </label>
                <input
                  type="text"
                  placeholder="/home/user/repo or E:\Projects\repo"
                  value={localRepoPath}
                  onChange={(e) => setLocalRepoPath(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Display Name (optional)
                </label>
                <input
                  type="text"
                  placeholder="my-project"
                  value={localRepoName}
                  onChange={(e) => setLocalRepoName(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button
                onClick={handleAddLocalRepo}
                disabled={!localRepoPath.trim() || addLocalRepoMutation.isPending}
                className="shadow-sm"
              >
                {addLocalRepoMutation.isPending ? (
                  <>
                    <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                    Adding...
                  </>
                ) : (
                  "Add Repository"
                )}
              </Button>
              {addLocalRepoMutation.isError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {addLocalRepoMutation.error instanceof Error
                    ? addLocalRepoMutation.error.message
                    : "Failed to add"}
                </div>
              )}
            </div>
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              <p className="font-medium mb-1">Note:</p>
              <p>Local repositories are added as project workspaces. The repository will appear in your Projects list after adding.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Hiring */}
      <section className="space-y-4" data-testid="company-settings-team-section">
        <div>
          <h2 className="text-sm font-semibold">Hiring</h2>
          <p className="text-xs text-muted-foreground">Configure team member onboarding policies</p>
        </div>
        <div className="rounded-lg border border-border bg-card px-5 py-4 shadow-sm">
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </section>

      {/* Import / Export */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Company Packages</h2>
          <p className="text-xs text-muted-foreground">Import and export company data and configurations</p>
        </div>
        <div className="rounded-lg border border-border bg-card px-5 py-5 shadow-sm">
          <p className="text-sm text-muted-foreground mb-4">
            Manage your company data through dedicated import and export pages. These tools are also accessible from the{" "}
            <a href="/org" className="font-medium underline underline-offset-4 hover:text-foreground transition-colors">Org Chart</a> header.
          </p>
          <div className="flex items-center gap-3">
            <Button size="default" variant="outline" asChild className="shadow-sm">
              <a href="/company/export">
                <Download className="mr-2 h-4 w-4" />
                Export Data
              </a>
            </Button>
            <Button size="default" variant="outline" asChild className="shadow-sm">
              <a href="/company/import">
                <Upload className="mr-2 h-4 w-4" />
                Import Data
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* Danger Zone */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-destructive">Danger Zone</h2>
          <p className="text-xs text-muted-foreground">Irreversible and destructive actions</p>
        </div>
        <div className="space-y-4 rounded-lg border-2 border-destructive/30 bg-destructive/5 px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/20">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-destructive">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-medium">Archive Company</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Archive this company to hide it from the sidebar. The company data will persist in
                the database but will no longer be accessible from the main navigation.
              </p>
              <div className="mt-4 flex items-center gap-3">
                <Button
                  size="default"
                  variant="destructive"
                  disabled={
                    archiveMutation.isPending ||
                    selectedCompany.status === "archived"
                  }
                  onClick={() => {
                    if (!selectedCompanyId) return;
                    const confirmed = window.confirm(
                      `\u26a0\ufe0f Archive company "${selectedCompany.name}"?\n\nThis will hide the company from the sidebar. You can restore it later from archived companies.`
                    );
                    if (!confirmed) return;
                    const nextCompanyId =
                      companies.find(
                        (company) =>
                          company.id !== selectedCompanyId &&
                          company.status !== "archived"
                      )?.id ?? null;
                    archiveMutation.mutate({
                      companyId: selectedCompanyId,
                      nextCompanyId
                    });
                  }}
                  className="shadow-sm"
                >
                  {archiveMutation.isPending
                    ? "Archiving..."
                    : selectedCompany.status === "archived"
                    ? "Already archived"
                    : "Archive company"}
                </Button>
                {archiveMutation.isError && (
                  <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {archiveMutation.error instanceof Error
                      ? archiveMutation.error.message
                      : "Failed to archive company"}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
