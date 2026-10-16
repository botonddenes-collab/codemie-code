# Spec: whitelisted managed-MCP catalog in `codemie mcp` (EPMCDME-9766)

Entirely inside codemie-code. Supersedes the pre-rescope backend design (`jira-spec-attachment.md`), which is not followed.

## Goal

Let users browse the curated managed-MCP catalog and install an entry by name into an agent, without sourcing URLs themselves. Only catalog entries are installable this way.

## Behavior

### Catalog resolution (shared helper, new)
- Source: `fetchManagedMcpServers('claude-desktop', codeMieUrl)` (`src/cli/commands/proxy/connectors/managed-mcp-remote.ts`). The client id lives in one exported constant.
- `codeMieUrl` and credentials come from the active profile via ConfigLoader plus stored SSO credentials. With no profile or credentials, use the bundled `desktop-managed-mcp-servers.json` and print a notice.
- Fetch returns `null` (failure): use the bundled list and print a notice.
- Fetch returns `[]` (authoritative empty): the catalog is empty and nothing is installable.
- Fetch returns entries: merge with bundled using the existing Desktop rules (`mergeManagedMcpServers` in `connectors/desktop.ts`). Extract the merge/fallback logic so Desktop and `mcp` share it; Desktop behavior must not change.
- Bundled entries are normalized to `CanonicalMcpEntry` for display.

### `codemie mcp list --catalog`
Prints catalog entries: name, transport, auth (oauth/none), url, description when present, and an "installable" marker. Entries with stdio transport, no url, or a transport other than http/sse are shown but marked not installable. Without `--catalog`, `list` is unchanged (claude passthrough).

### `codemie mcp install <name> [--agent=claude|codex|gemini] [--scope <s>]`
- Default agent: `claude`. Unknown agent is a usage error.
- Name lookup: case-insensitive, exact match. No match is an error that points to `list --catalog` and states that arbitrary URLs need `mcp add`. Never accepts a URL as the name.
- Non-installable entries are refused with a clear message.
- Registration shells out to the agent's own CLI, running `codemie-mcp-proxy <catalog url>` as a stdio server. The user never supplies the URL.
  - claude: reuse the existing `claude mcp add [--scope] <name> -- codemie-mcp-proxy <url>` path.
  - codex: `codex mcp add <name> -- codemie-mcp-proxy <url>`.
  - gemini: `gemini mcp add [--scope] <name> codemie-mcp-proxy <url>` (stdio is gemini's default transport).
- Preconditions as today: `ensureProxyCommandExists()`. Missing agent CLI gives a clear error naming the agent and how to install it (`codemie install <agent>`).
- The registered name is the catalog entry's canonical name. OAuth config is not forwarded; `codemie-mcp-proxy` handles OAuth itself.
- Uses the `exec` helper from `src/utils/exec.ts`. The claude helper currently calls `process.exit`; refactor so it can be reused without changing `add`/`remove` behavior or their exact exec args.

### `mcp add <name> <url>`
Unchanged. It remains the only path for arbitrary URLs.

## Acceptance criteria
1. `codemie mcp list --catalog` shows catalog entries with details and an installable marker.
2. `codemie mcp install <name> --agent=claude|codex|gemini` resolves name to URL from the catalog and registers via `codemie-mcp-proxy` through that agent's CLI.
3. Names not in the catalog (including URLs) are rejected by `install`.
4. Backend `null` falls back to bundled with a notice; `[]` yields an empty catalog; no profile falls back to bundled with a notice.
5. Name match is case-insensitive; non-http/sse and url-less entries are listed but refused.
6. Existing `mcp add/remove/list` tests and Desktop connector behavior are unchanged.

## Non-goals
- No backend changes and no new backend endpoints (`/v1/mcp-configs` design is not used).
- No direct writes to agent config files (codex TOML, gemini settings.json).
- No stdio or non-http/sse catalog installs.
- No new `?client=` id and no OAuth flow in the CLI.
- No install tracking, `uninstall` command, or catalog caching.
- No changes to the bundled catalog contents.
- Not extending `install` to agents beyond claude, codex, gemini.

## Testing note
Vitest unit tests following the existing `mcp/__tests__/index.test.ts` mocking pattern: resolver cases (null, [], entries, no profile), lookup and refusal cases, exact exec args per agent.
