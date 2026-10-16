/** Agents `codemie mcp install` can register a catalog server with. */
export type McpInstallAgent = 'claude' | 'codex' | 'gemini';

export const MCP_INSTALL_AGENTS: readonly McpInstallAgent[] = ['claude', 'codex', 'gemini'];

/** Proxy binary each agent CLI launches as its MCP stdio server. Fixed, never user input. */
const PROXY_COMMAND = 'codemie-mcp-proxy';

/**
 * Build the argv for `<agent> mcp add`, registering the proxy as the stdio server.
 * Pure: no I/O and no process execution. `scope` is applied only where the agent CLI
 * accepts `--scope` (claude, gemini); codex has no scope flag and ignores it.
 */
export function buildAddArgs(
  agent: McpInstallAgent,
  name: string,
  url: string,
  scope?: string,
): string[] {
  const scopeArgs = scope ? ['--scope', scope] : [];
  switch (agent) {
    case 'claude':
      return ['mcp', 'add', ...scopeArgs, name, '--', PROXY_COMMAND, url];
    case 'codex':
      return ['mcp', 'add', name, '--', PROXY_COMMAND, url];
    case 'gemini':
      return ['mcp', 'add', ...scopeArgs, name, PROXY_COMMAND, url];
  }
}
