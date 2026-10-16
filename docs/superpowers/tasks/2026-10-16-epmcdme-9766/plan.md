# Managed-MCP Catalog in `codemie mcp` Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Add `codemie mcp list --catalog` and `codemie mcp install <name> [--agent=claude|codex|gemini] [--scope]`, installing only catalog entries via `codemie-mcp-proxy`.

**Architecture:** A shared catalog resolver (backend via `fetchManagedMcpServers` + bundled fallback, merge rules extracted from `connectors/desktop.ts`) feeds two new `mcp` subcommands. Registration shells out to each agent's own CLI through `exec` from `src/utils/exec.ts`; no agent config files are written. Layering (`architecture.md`): the `mcp` command stays the CLI layer; catalog resolution and argv building live in separate non-Commander modules (no business logic in the Commander actions), depend only downward on `src/utils/` and the existing connector modules, and import no agent plugin (plugins stay isolated; the agent CLI binary names are fixed constants here, not an `AgentAdapter` change).

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes), Commander, Vitest.

**Spec:** `docs/superpowers/tasks/2026-10-16-epmcdme-9766/spec.md`

## Conventions (guides that constrain every task)

- **Git** (`standards/git-workflow.md`): commit per task using the repository's existing convention, Conventional Commits `<type>(<scope>): <lowercase imperative>`, first line <=72 chars (commitlint max 100). Scope must come from the allowed list (`cli`, `proxy`, `utils`, `tests`, ...); suggested: Task 1 `refactor(proxy)`, Tasks 2-5 `feat(cli)`. No ticket key in the subject (use the body footer). Never `--no-verify`; husky runs lint-staged, typecheck, commitlint.
- **Code quality** (`standards/code-quality.md`): new files kebab-case; `.js` import extensions; `@/` alias in new files (not `../../..`); `import type` for type-only; explicit return types and JSDoc on exports; `interface` for shapes; functions <50 lines (split the `install` action into helpers); files <500 lines; no `console.log` for debug (use `logger.debug`); `console.error/log` only for deliberate user output as the existing `mcp/index.ts` does.
- **Development practices**: throw project error classes from `src/utils/errors.ts` in new helpers (`ConfigurationError` for unknown agent / not-in-catalog / non-installable, `ToolExecutionError` for missing proxy or agent CLI; check constructor signatures there); the Commander action is the only place that formats via `createErrorContext`/`formatErrorForUser` and calls `process.exit(1)`. Process execution only via `exec` (`src/utils/exec.ts`) and `getCommandPath` (`src/utils/processes.ts`), never raw `child_process`.
- **Security** (`security/security-practices.md`): the registered URL comes only from the catalog entry, never from user input; argv is passed as an array (no shell string building; `shell` only for win32 as in the existing claude path); names validated (`-` prefix rejected, catalog names already match `/^[a-zA-Z0-9_-]+$/`); log with `logger` + `sanitizeLogArgs`, never log credentials or SSO tokens; do not touch any `X-CodeMie-*` attribution header or the proxy header-injection path.
- **Testing** (`testing/testing-patterns.md`): co-located `__tests__/*.test.ts`, `@group unit` header, nested `describe`, one concept per `it`, dynamic `import()` after `vi.mock`/spies, `vi.restoreAllMocks()` in `afterEach`.
- **Quality gates** (`quality-gates.md`): code must satisfy lint with zero warnings, typecheck, build, license-check and the unit project; the calling flow runs these, no task here runs them as a separate step beyond per-task test runs. The build already copies `desktop-managed-mcp-servers.json`; Task 1 must not move it.

## Global Constraints

- Default agent `claude`; unknown agent is a usage error.
- Lookup: case-insensitive exact name; a URL or unknown name is rejected with a message pointing to `list --catalog` and stating arbitrary URLs need `mcp add`.
- Only http/sse entries with a url are installable; others are listed but refused.
- Client id constant: `'claude-desktop'` (one exported constant). No OAuth forwarding.
- `mcp add/remove/list` (without `--catalog`) and Desktop connector behavior and exact exec args unchanged.
- Registered name is the catalog entry's canonical name.

## Review Focus

- Name given as a URL (`https://x/mcp`) or starting with `-`: rejected, nothing executed.
- Mixed-case input (`NOTION`) resolves to bundled `Notion` and registers as `Notion`.
- Backend `[]` then install of a bundled name: refused (catalog empty).
- stdio / non-http entry from backend: shown "not installable", install refused.
- Agent CLI missing or `codemie-mcp-proxy` missing: clear error naming agent / `codemie install <agent>`, no exec of the add.

## Negative-constraint pass

Non-goals honored: no backend changes (Tasks 1-2 only reuse fetch); no direct config writes (Task 3 uses CLI `exec` only); no stdio installs (Task 2 `installable`, Task 5 refusal); no new client id (constant reused); no bundled JSON edits (Task 1 touches TS only); no uninstall/caching/extra agents (none planned).

---

### Task 1: Extract shared managed-MCP defaults and merge logic

**Files:**
- Create: `src/cli/commands/proxy/connectors/managed-mcp-catalog.ts`
- Modify: `src/cli/commands/proxy/connectors/desktop.ts:28,76-77,397-512` (move `ManagedMcpServerEntry`, `DEFAULT_MANAGED_MCP_SERVERS`, `cloneManagedEntry`, `mergeManagedMcpServers`, result types and their private helpers `hasManagedOAuth`/`sameManagedEndpoint`/`sameManagedName`/`collidesWithManagedEntry`); re-export all from `desktop.ts` so existing imports and `desktop.test.ts` keep working.

**Interfaces:**
- Produces: the moved symbols with unchanged signatures, exported from `managed-mcp-catalog.ts`.

Test-first: no — pure move; the existing `desktop.test.ts` (merge/clone/defaults cases) is the regression net and must stay green untouched.

- [ ] **Step 1:** Move the symbols; keep `selectDefaultsForFailedFetch` and Desktop-only code in `desktop.ts` (it uses desktop parsing helpers). `managed-mcp-catalog.ts` must not import `desktop.ts` (no cycle). Imports use `@/` alias and `.js`.
- [ ] **Step 2:** Run `npx vitest run src/cli/commands/proxy/connectors`; expect PASS with no test edits.

### Task 2: Catalog resolver

**Files:**
- Create: `src/cli/commands/mcp/catalog.ts`
- Test: `src/cli/commands/mcp/__tests__/catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; `fetchManagedMcpServers`, `CanonicalMcpEntry` (`managed-mcp-remote.ts`); `ConfigLoader.load` (verified, below).
- Produces:
```ts
export const MCP_CATALOG_CLIENT_ID = 'claude-desktop';
export interface CatalogEntry { entry: CanonicalMcpEntry; installable: boolean }
export interface ResolvedCatalog { entries: CatalogEntry[]; notices: string[] }
export async function resolveCatalog(): Promise<ResolvedCatalog>;
export function findCatalogEntry(catalog: ResolvedCatalog, name: string): CatalogEntry | undefined; // case-insensitive exact
```

**ConfigLoader (verified at `src/utils/config.ts:91-201`):** `static async load(workingDir: string = process.cwd(), cliOverrides?: Partial<CodeMieConfigOptions>): Promise<CodeMieConfigOptions>`. It does not throw for a missing profile: it returns built-in defaults overlaid with whatever global/local/env config exists, so "no profile" shows up as `config.codeMieUrl` being `undefined` (the field is a `CodeMieConfigOptions` member, also populated from `CODEMIE_URL`). Call it as `ConfigLoader.load()` with no arguments (active profile, cwd), wrap in try/catch for IO/parse failures, and treat a falsy `codeMieUrl` as "no profile": do not call fetch, use bundled and add a notice. Do not log the config object.

Test-first: yes — `resolveCatalog` returns bundled entries plus a notice when fetch returns `null`; returns `entries: []` when fetch returns `[]`; merges backend + bundled (backend wins collisions) when entries returned; returns bundled plus a notice when `ConfigLoader.load` yields no `codeMieUrl` or throws (fetch not called); `findCatalogEntry(cat, 'NOTION')` finds `Notion`; `installable` is false for stdio/non-http/sse.

- [ ] **Step 1:** Write `catalog.test.ts` (`@group unit`) with the cases above; mock `managed-mcp-remote.js` and `@/utils/config.js`, dynamic import after mocks.
- [ ] **Step 2:** Run `npx vitest run src/cli/commands/mcp/__tests__/catalog.test.ts`; expect FAIL (module missing).
- [ ] **Step 3:** Implement `resolveCatalog`. Bundled entries convert to `CanonicalMcpEntry` (`auth: oauth ? 'oauth' : 'none'`). For fetched entries, run http/sse ones through `mergeManagedMcpServers(bundled, org)`; carry non-http/sse fetched entries through as non-installable. Missing SSO credentials make fetch return `null`, which takes the null branch. Any debug logging goes through `logger.debug(..., ...sanitizeLogArgs({...}))`.
- [ ] **Step 4:** Run the same test; expect PASS.

### Task 3: Per-agent registration helpers (and claude refactor)

**Files:**
- Create: `src/cli/commands/mcp/agent-registration.ts`
- Modify: `src/cli/commands/mcp/index.ts:38-60` (split `runClaudeMcpCommand`: new `execClaudeMcp(...): Promise<number>` returns the exit code and contains the error-to-code mapping; `runClaudeMcpCommand` becomes `process.exit(await execClaudeMcp(...))`, behavior and exec args identical)
- Test: `src/cli/commands/mcp/__tests__/agent-registration.test.ts`; existing `index.test.ts` must stay green.

**Interfaces:**
- Produces:
```ts
export type McpInstallAgent = 'claude' | 'codex' | 'gemini';
export const MCP_INSTALL_AGENTS: readonly McpInstallAgent[];
export function buildAddArgs(agent: McpInstallAgent, name: string, url: string, scope?: string): string[];
```
Expected (pending Step 1): claude `['mcp','add',...(scope?['--scope',scope]:[]),name,'--','codemie-mcp-proxy',url]`; codex `['mcp','add',name,'--','codemie-mcp-proxy',url]`; gemini `['mcp','add',...(scope?['--scope',scope]:[]),name,'codemie-mcp-proxy',url]`.

Test-first: yes — `buildAddArgs` returns the exact arrays above for each agent with and without scope; `index.test.ts` add/remove/list exec-arg assertions still pass after the refactor.

- [ ] **Step 1: Verify codex and gemini syntax (spec flags it unverified).** Run `codex mcp add --help` and `gemini mcp add --help` if installed (else check upstream docs for `@openai/codex` and `@google/gemini-cli`). Confirm: codex `mcp add <name> -- <cmd> [args]`; gemini `mcp add [--scope] <name> <commandOrUrl> [args]` with stdio default, and whether `--` is needed before args that look like flags. Adjust the expected arrays here and in Task 5 if the real syntax differs; if an agent has no `mcp add`, stop and return the finding to the caller instead of guessing. Also confirm whether codex accepts `--scope` (spec says no).
- [ ] **Step 2:** Write the failing `agent-registration.test.ts`; run it; expect FAIL.
- [ ] **Step 3:** Implement `buildAddArgs` (pure, no I/O, no plugin imports); do the `execClaudeMcp` split in `index.ts`.
- [ ] **Step 4:** Run `npx vitest run src/cli/commands/mcp`; expect PASS including untouched `index.test.ts`.

### Task 4: `codemie mcp list --catalog`

**Files:**
- Modify: `src/cli/commands/mcp/index.ts:152-169` (`createMcpListCommand`: add `--catalog` option; without it keep the claude passthrough exactly)
- Test: `src/cli/commands/mcp/__tests__/index.test.ts` (add cases; mock `../catalog.js`)

**Interfaces:**
- Consumes: `resolveCatalog` and `CatalogEntry` from Task 2.

Test-first: yes — with `--catalog`, output includes each entry's name, transport, auth, url, description (when present) and an installable marker, prints notices, shows a stdio entry marked not installable, prints an "empty" message for `[]`, and never execs claude; without `--catalog` the exec is still `['mcp','list']`.

- [ ] **Step 1:** Add failing tests (spy `console.log`); run `npx vitest run src/cli/commands/mcp/__tests__/index.test.ts`; expect FAIL.
- [ ] **Step 2:** Implement catalog printing in a small helper (formatting separate from the action); notices via `console.warn`; exit code 0. Printed URLs are catalog data only.
- [ ] **Step 3:** Run the test file; expect PASS.

### Task 5: `codemie mcp install <name>`

**Files:**
- Modify: `src/cli/commands/mcp/index.ts` (new `createMcpInstallCommand()`, register in `createMcpCommand()` at line ~171; claude keeps `resolveClaudeCommand`, codex/gemini use `getCommandPath('codex'|'gemini')`; split lookup/validation/exec into helpers each <50 lines)
- Test: `src/cli/commands/mcp/__tests__/index.test.ts`

**Interfaces:**
- Consumes: `resolveCatalog`, `findCatalogEntry` (Task 2); `buildAddArgs`, `MCP_INSTALL_AGENTS` (Task 3); `execClaudeMcp` for claude.

Test-first: yes — install tests: (a) `install notion --agent=claude` execs exact claude args with name `Notion` and catalog URL; (b) codex and gemini exec the exact args from Task 3; (c) default agent is claude; (d) `--agent=foo` exits 1 without exec; (e) `https://evil.example/mcp` and unknown names exit 1, message mentions `list --catalog` and `mcp add`, no exec; (f) stdio entry refused; (g) missing `codemie-mcp-proxy` and missing agent CLI error messages (latter names the agent and `codemie install <agent>`), no add exec; (h) name starting with `-` rejected.

- [ ] **Step 1:** Write the failing tests following the existing `mockClaudeResolved` / `process.exit` spy pattern; run; expect FAIL.
- [ ] **Step 2:** Implement the command: validate agent, reject `-` names, resolve catalog + print notices, `findCatalogEntry`, refuse non-installable, `ensureProxyCommandExists()`, resolve agent CLI, exec `buildAddArgs(...)` via `exec` with `{ interactive: true, shell }`, propagate exit code. Helpers throw the project error classes; only the action catches, formats (`createErrorContext`/`formatErrorForUser`), and exits 1.
- [ ] **Step 3:** Run `npx vitest run src/cli/commands/mcp`; expect PASS.
- [ ] **Step 4:** Add a short `codemie mcp list --catalog` / `install` usage note where `codemie mcp add` is currently documented (Grep `README.md` and `docs/`; public docs must be updated when behavior changes per the git-workflow review checklist); skip if not documented anywhere.
