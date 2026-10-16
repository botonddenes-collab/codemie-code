# Technical Research

**Task**: mcp catalog cli
**Generated**: 2026-10-16
**Research path**: codegraph

---

## 1. Original Context

Jira EPMCDME-9766 — "Predefined & Whitelisted MCP List in codemie-code CLI for Safe, One-Command Installation".
RESCOPED 2026-09-25 (this is the scope to implement; entirely inside the codemie-code repo):
State: a curated managed-MCP catalog already exists and feeds Claude Desktop via `codemie proxy connect --desktop` (bundled desktop-managed-mcp-servers.json + GET /v1/mcp/managed-servers; structured OAuth hardened under EPMCDME-14072).
Remaining: the catalog is wired only to the Desktop connector. `codemie mcp` exposes only `add <name> <url>` / `remove` / `list` with arbitrary-URL passthrough — there is no `codemie mcp install <name> --agent=...` that resolves name→URL from the whitelist.
Narrowed scope: Wire the managed-MCP catalog into `codemie mcp` for one-command, whitelisted install across agents (reuse fetchManagedMcpServers() / CanonicalMcpEntry).
Acceptance criteria:
- `codemie mcp list --catalog` shows catalog entries with details.
- `codemie mcp install <name> [--agent=claude|codex|gemini]` resolves name→URL and registers via the existing proxy path.
- Only catalog entries are installable via this path (arbitrary URL still requires explicit `mcp add`).
- Catalog stays sourced from /v1/mcp/managed-servers + bundled fallback. Stays entirely in codemie-code.
Background (original pre-rescope intent, superseded in mechanism): users browse a curated list (context7, figma, jira, github, gitlab, azure devops...) and install to a specific agent without sourcing URLs from the internet; install is local-only (writes agent config). Reference copy of the outdated attachment: docs/superpowers/tasks/2026-10-16-epmcdme-9766/jira-spec-attachment.md (backend design — do NOT follow its mechanism).
Repo conventions: read AGENTS.md and the relevant .ai-run/guides/ (architecture, development-practices, testing-patterns, exposed-api) first. Key code to investigate: the `codemie mcp` command under src/cli/commands, src/cli/commands/proxy/connectors/managed-mcp-remote.ts (fetchManagedMcpServers, CanonicalMcpEntry), the bundled desktop-managed-mcp-servers.json, how `mcp add` registers servers "via the existing proxy path" per agent (claude/codex/gemini), src/utils/mcp-config.ts, and tests for these.

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/mcp/index.ts` — `createMcpCommand()` with three subcommands built by `createMcpAddCommand/RemoveCommand/ListCommand`. All three shell out to the **claude** CLI only (`claude mcp add|remove|list`). `add <name> <url> [--scope]`: validates URL with `new URL`, rejects names starting `-`, calls `ensureProxyCommandExists()` (looks up `codemie-mcp-proxy` on PATH), `resolveClaudeCommand()` (tries `~/.local/bin/claude --version`, then PATH), then `runClaudeMcpCommand(..., ['mcp','add',[--scope s],name,'--','codemie-mcp-proxy',url])`, which calls `process.exit(code)` (returns `Promise<never>`). `list` takes no options and passes through to `claude mcp list`.
- No `--agent` option and no codex/gemini registration path exists in the `mcp` command. Registration is claude-only today.
- `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` — `CanonicalMcpEntry {name, transport: http|sse|stdio, url?, auth?: oauth|none, oauth?: McpOAuthConfig|boolean, description?, clients?: string[]}`; `fetchManagedMcpServers(client: string, codeMieUrl: string): Promise<CanonicalMcpEntry[]|null>`. Returns `null` on any failure (no SSO creds, non-2xx, non-array, all entries invalid, exception), `[]` only for an authoritative empty list. Uses `CodeMieSSO.getStoredCredentials(codeMieUrl)`, builds `<apiUrl>/v1/mcp/managed-servers?client=<client>`, `HTTPClient` (10s timeout, 3 retries), `buildAuthHeaders`. Validation (`isValidCanonicalEntry`): name must match `/^[a-zA-Z0-9_-]+$/`, transport in set, `url` must be a string (note: `url` is required by validation despite being optional in the type). Invalid entries dropped with a warn log. Only caller today: `runClaudeDesktop` in `src/cli/commands/proxy/connect-orchestrator.ts:449`, passing client `'claude-desktop'` and `state.syncCodeMieUrl`.
- `src/cli/commands/proxy/connectors/desktop-managed-mcp-servers.json` — bundled fallback (7 entries: Notion, Linear, Box, Canva, Vercel, Netlify, Miro; shape `{name,url,transport:"http",oauth:true}`). Names are capitalized and contain no description field. None of context7/figma/jira/github/gitlab/azure devops named in the ticket are in the bundle. Exposed as `DEFAULT_MANAGED_MCP_SERVERS` in `desktop.ts:76` typed `ManagedMcpServerEntry[]` (`{name,url,transport?: http|sse, oauth?}`), NOT `CanonicalMcpEntry`.
- `src/cli/commands/proxy/connectors/desktop.ts` — `mapCanonicalToDesktop`, `resolveDesktopOAuth`, `isValidMcpServerName`, `DESKTOP_SUPPORTED_TRANSPORTS` (http/sse only), `mergeManagedMcpServers` (bundled-vs-backend collision precedence and oauth downgrade logging), `selectDefaultsForFailedFetch` (bundled defaults used on failed fetch), `reconcileManagedMcpServers`, `writeDesktopConfig`. The merge/fallback logic is Desktop-specific and lives in this connector; there is no shared "resolve catalog = backend + bundled" helper yet.
- `src/utils/mcp-config.ts` — read-only: `getMCPConfigSummary(AgentMCPConfig, cwd)` for session metrics; reads agent config JSON via `MCPConfigSource {path, jsonPath}` (supports `~/`, `{cwd}`, multi-candidate paths). It does not write MCP config.
- `src/agents/core/types.ts` — `AgentMetadata.mcpConfig?: AgentMCPConfig {local,project,user}` declares where each agent stores MCP servers (e.g. Claude `~/.claude.json` → `projects[cwd].mcpServers`). Per-agent metadata for claude/codex/gemini lives in `src/agents/plugins/{claude,codex,gemini}/*.plugin.ts`. Codex config is TOML (`src/cli/commands/proxy/connectors/codex-config-toml.ts` has managed-block splicing helpers: `spliceManagedBlocks`, `buildManagedBlocks`, `toTomlString`); Gemini uses `settings.json` (`ensureJsonFile` in `beforeRun`).
- `src/mcp/stdio-http-bridge.ts`, `src/mcp/auth/mcp-oauth-provider.ts`, `src/providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts` — implementation of `codemie-mcp-proxy` (stdio↔HTTP bridge with in-memory OAuth); the "existing proxy path" is the `codemie-mcp-proxy <url>` command that agents launch as a stdio server. `MCPAuthPlugin` (`/mcp_auth`, `/mcp_relay`) caps distinct MCP origins and blocks private/loopback targets.
- `src/plugins/loaders/mcp-loader.ts` and `src/plugins/core/types.ts` (`McpConfig`, `McpServerConfig {command,args,env,cwd}`) are the plugin-manifest MCP loader — unrelated to `codemie mcp`.

### Architecture and Layers Affected
- CLI layer: `src/cli/commands/mcp/index.ts` (add subcommand `install`, add `--catalog` to `list`).
- Connector/catalog layer: `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` (fetch/validation) and `desktop.ts` (bundled defaults).
- Auth/config layer: `CodeMieSSO` credentials, `ConfigLoader` profiles (source of the CodeMie URL; `DaemonState.syncCodeMieUrl` is what the orchestrator uses, which the `mcp` command would not have).
- Agent metadata layer: `AgentMetadata.mcpConfig` (read-only descriptors per agent).

### Integration Points
- `fetchManagedMcpServers` requires `codeMieUrl`; the `mcp` command currently has no profile/config loading. Open question for design: how `mcp install` obtains the URL (ConfigLoader active profile vs. other).
- `codemie-mcp-proxy` binary must be on PATH (checked by `ensureProxyCommandExists`).
- Claude CLI (`claude mcp add`) is the only registration mechanism implemented.

### Patterns and Conventions
- Commander: `createXCommand(): Command` factory functions, `mcp.addCommand(...)`.
- `.js` extensions on imports; `@/` alias is used in connector code, while `mcp/index.ts` uses relative `../../../utils/...` imports.
- Errors: user-facing `console.error` + `process.exit(1)` in this file; AGENTS.md prescribes project error classes (`ConfigurationError`, etc.) and `logger`/`sanitizeLogArgs` for logging.
- Paths via `getCodemiePath()` / `resolveHomeDir`; exec via `src/utils/exec.ts` / `processes.ts`, not raw `child_process`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
Guides present in `.ai-run/guides/`: `architecture/architecture.md`, `development/development-practices.md`, `testing/testing-patterns.md`, `integration/exposed-api.md`, `integration/external-integrations.md`, `security/security-practices.md`, `standards/code-quality.md`, `usage/project-config.md`, `project.md`, `quality-gates.md`, `standards/git-workflow.md`. These were located but not read in this pass; AGENTS.md (read) says guides win on process, source wins on facts, and routes `cli/command` tasks to architecture + development-practices. `docs/AGENTS.md` documents agents (Claude, Codex, Gemini) but has no MCP-install content.

### Architectural Decisions
- AGENTS.md: CLI -> Registry -> Plugin layering; tests and git operations only on explicit request.
- Managed-MCP code comments record decisions: `null` vs `[]` fetch semantics (failure must not revoke), OAuth config is forwarded verbatim (CLI does not run the flow for Desktop), unknown backend keys must survive.
- Pre-rescope `jira-spec-attachment.md` is explicitly not to be followed.

### Derived Conventions
- Catalog entries are client-filtered via `?client=<id>` query param and optional `CanonicalMcpEntry.clients`; the existing client id is `claude-desktop`. Which client id(s) a CLI install should send is not established anywhere in the code.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/mcp/__tests__/index.test.ts` — Vitest unit tests for `createMcpCommand` add/remove/list; mocks `utils/exec.js`, `utils/processes.js`, `utils/paths.js`; `vi.resetModules()` + dynamic `import('../index.js')`; spies `process.exit` to throw `process.exit:<code>`; helper `mockClaudeResolved(code)`. Asserts exact `exec` args e.g. `['mcp','add','my-server','--','codemie-mcp-proxy','https://example.com/mcp']`, `{interactive:true, shell}`.
- `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts` — fetch/validation of canonical entries.
- `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` — mapping, merge, reconcile, writeDesktopConfig.
- `src/utils/__tests__/mcp-config.test.ts`, `src/agents/plugins/pi/__tests__/pi.mcp-config.test.ts` — config summary reading.
- `src/mcp/__tests__/mcp-auth.test.ts`, `mcp-bridge-logger.test.ts` — bridge/OAuth.
- `tests/integration/cli-commands/skills.test.ts` — subprocess e2e pattern for a sibling command (not for mcp).

### Testing Framework and Patterns
Vitest, `@group unit` header, dynamic imports after mocks. Not read in full: `.ai-run/guides/testing/testing-patterns.md`.

### Coverage Gaps
- No tests or code for catalog access from the `mcp` command, nor for codex/gemini MCP registration (neither exists).
- `MCPAuthInterceptor` has no tests within 3 caller hops (per codegraph).

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_DEBUG` (debug logging), `MCP_CLIENT_NAME` (OAuth client_name in the bridge). Others not surfaced in this pass.

### Configuration Files
- `desktop-managed-mcp-servers.json` (bundled catalog, imported into `desktop.ts`; a copy exists under `dist/` so the build already copies it).
- Agent MCP stores: Claude `~/.claude.json` (via `claude mcp`), Codex TOML under `CODEX_HOME` (defaults to `~/.codex/codemie/home` when run through codemie), Gemini `settings.json` under its data path.
- Managed state: `getCodemiePath('proxy','desktop-managed-mcp-state.json')` (Desktop-only marker).
- CodeMie URL / SSO creds: `CodeMieSSO.getStoredCredentials(codeMieUrl)`; profiles via `ConfigLoader`.

### Feature Flags and Deployment Concerns
None found for MCP. `bin/codemie-mcp-proxy.js` is declared in `package.json:bin`.

---

## 6. Risk Indicators

- `mcp` command is claude-only; `--agent=codex|gemini` has no existing registration code in the `mcp` command (agent metadata only describes read locations). Codex TOML helpers exist in `proxy/connectors/codex-config-toml.ts`; no Gemini MCP writer found.
- Fetch needs a CodeMie URL and SSO credentials that the `mcp` command does not currently load; failure returns `null` (offline/unauthenticated), which makes bundled-fallback behavior essential.
- Bundled fallback is typed `ManagedMcpServerEntry` (Desktop shape, no `description`), and its 7 names differ from the ticket's examples (context7, figma, jira, github, gitlab, azure devops). Mapping to `CanonicalMcpEntry` for display/details is not provided.
- Backend/bundle merge and collision rules exist only inside Desktop code (`mergeManagedMcpServers`, `selectDefaultsForFailedFetch`).
- Name matching: bundled names are capitalized (`Notion`) while `VALID_NAME` allows mixed case; name lookup case-sensitivity is unspecified.
- Catalog entries with `transport: stdio` or no OAuth are possible from the backend; `codemie-mcp-proxy` takes a URL, so only http/sse entries fit that path.
- `process.exit` inside `runClaudeMcpCommand` complicates reuse and testing of the claude path.
- Existing `add` tests assert exact exec args; changes to shared helpers risk regressions.
- Speculative: the `?client=` value for CLI installs may need backend agreement (only `claude-desktop` is used today).
- Guides not yet read in this pass (testing-patterns, exposed-api, architecture).

---

## 7. Summary for Complexity Assessment

The change lives mainly in one CLI file (`src/cli/commands/mcp/index.ts`) plus reuse of the connector-layer catalog code (`managed-mcp-remote.ts`, bundled JSON and `DEFAULT_MANAGED_MCP_SERVERS` in `desktop.ts`) and its existing test file. The catalog fetch, validation, and a bundled fallback already exist; what does not exist is any consumer outside the Desktop connector, a shared backend-plus-bundled resolution helper, access to the CodeMie URL from the `mcp` command, and any per-agent registration beyond Claude.

Technical novelty is low for the Claude path (it reuses `claude mcp add -- codemie-mcp-proxy <url>`) and higher for codex and gemini, for which there is no existing MCP write path in the `mcp` command (Codex TOML splice helpers exist elsewhere). Test posture is good for the surrounding code (mcp command, managed-mcp-remote, desktop all have Vitest unit tests with clear mocking patterns), but there is zero coverage of the new behaviors, which would be new tests.

Key risk factors: the multi-agent registration surface, obtaining a CodeMie URL and credentials in the `mcp` command, offline fallback semantics, a catalog whose bundled contents differ from the ticket's examples, and a Desktop-specific merge/fallback implementation that would need to be reused without regressing Desktop behavior.

---

## 8. External References

`docs/superpowers/tasks/2026-10-16-epmcdme-9766/jira-spec-attachment.md` — resolved (read first 60 lines). It is the pre-rescope backend (Python/FastAPI) design: `GET /v1/mcp-configs?is_system=true&active_only=true`, new `GET /v1/mcp-configs/by-name/{name}` (case-insensitive exact match, system config wins, 404 otherwise), CLI flow `codemie-code mcp list` / install writing to the agent config file (e.g. `~/.claude/settings.json`), install is local-only with no server-side tracking. Its header states it is superseded by the 2026-09-25 rescope and must not be followed for mechanism; only intent is relevant (list curated MCPs, install by name, local-only).
