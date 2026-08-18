# Agent Rules for Paperclip

## Project
- **Stack**: Express + TypeScript server, React + Vite UI, pnpm monorepo (24 packages)
- **Dev**: `pnpm dev` from repo root (starts server + UI with hot reload)
- **DB**: Drizzle ORM, PostgreSQL at `localhost:5433`
- **Build check**: `pnpm build` — must pass before marking done

## Architecture
- `server/src/` — Express API server
- `server/src/routes/` — API route handlers
- `server/src/services/` — Business logic (heartbeat, projects, issues, agents)
- `ui/src/` — React dashboard (Vite)
- `ui/src/pages/` — Page components
- `ui/src/components/` — Shared UI components
- `packages/db/` — Drizzle schema, migrations
- `packages/shared/` — Shared types and validation schemas

## Rules

### Code Style
- Server: TypeScript, Express handlers, Drizzle queries
- UI: React + TypeScript, Tailwind CSS
- Use existing patterns — look at neighboring files before writing new code
- All route handlers use `assertCompanyAccess(req, companyId)` for auth

### Critical Constraints
- **OpenClaw is SoT** — Paperclip is a stateful DB + UI dashboard only
- Heartbeat loop is DISABLED in `index.ts` — do not re-enable it
- Do NOT modify `resolveWorkspaceForRun()` without explicit approval
- Do NOT modify adapter registration code
- Do NOT add new DB migrations without explicit approval
- Do NOT modify `packages/db/src/schema/` without explicit approval

### Git Workflow
- Feature branch: `agent/<issue-identifier>-<short-desc>`
- Commit messages: imperative, reference the issue
- Push branch when done — do NOT create PRs

### Before Marking Done
1. `pnpm build` passes
2. No TypeScript errors
3. Server restarts cleanly (tsx watcher auto-reloads)
4. Test the change by hitting the API endpoint with curl

### Workspace
- Repo: `/home/avion/paperclip/`
- Server runs on port 3100
- UI dev server on port 5173 (Vite)
- pnpm monorepo — use `pnpm --filter @paperclipai/server` for server-only commands
