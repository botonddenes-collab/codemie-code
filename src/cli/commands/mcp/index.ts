import { Command } from 'commander';
import os from 'os';
import { exec } from '../../../utils/exec.js';
import { getCommandPath } from '../../../utils/processes.js';
import { resolveHomeDir } from '../../../utils/paths.js';
import { findCatalogEntry, resolveCatalog, type CatalogEntry, type ResolvedCatalog } from './catalog.js';
import { buildAddArgs, MCP_INSTALL_AGENTS, type McpInstallAgent } from './agent-registration.js';
import type { CanonicalMcpEntry } from '@/cli/commands/proxy/connectors/managed-mcp-remote.js';
import { ConfigurationError, ToolExecutionError, createErrorContext, formatErrorForUser } from '../../../utils/errors.js';

async function ensureProxyCommandExists(): Promise<void> {
  const proxyCommand = await getCommandPath('codemie-mcp-proxy');
  if (!proxyCommand) {
    throw new Error('proxy-not-found');
  }
}

async function resolveClaudeCommand(): Promise<{ command: string; shell: boolean }> {
  if (process.platform !== 'win32') {
    const fullPath = resolveHomeDir('.local/bin/claude');
    try {
      const result = await exec(fullPath, ['--version']);
      if (result.code === 0) {
        return { command: fullPath, shell: false };
      }
    } catch {
      // Fall back to PATH lookup below.
    }
  }

  const claudeCommand = await getCommandPath('claude');
  if (!claudeCommand) {
    throw new Error('claude-not-found');
  }

  return {
    command: claudeCommand,
    shell: os.platform() === 'win32',
  };
}

/**
 * Run an agent CLI `mcp` subcommand interactively and resolve with the exit code to propagate.
 * Never exits the process itself; the caller decides how to terminate.
 */
async function execMcpCommand(claudeCommand: string, useShell: boolean, args: string[]): Promise<number> {
  try {
    const result = await exec(claudeCommand, args, {
      interactive: true,
      shell: useShell,
    });
    return result.code;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      console.error('claude CLI not found. Install Claude Code: https://claude.ai/code');
      return 1;
    }

    if (message.includes('terminated by signal')) {
      return 1;
    }

    // exec rejects on non-zero exit in interactive mode — extract and propagate the code
    const match = /code (\d+)/.exec(message);
    return match ? parseInt(match[1], 10) : 1;
  }
}

async function runClaudeMcpCommand(claudeCommand: string, useShell: boolean, args: string[]): Promise<never> {
  process.exit(await execMcpCommand(claudeCommand, useShell, args));
}

interface McpInstallOptions {
  agent: string;
  scope?: string;
}

interface InstallTarget {
  name: string;
  url: string;
}

function isMcpInstallAgent(value: string): value is McpInstallAgent {
  return (MCP_INSTALL_AGENTS as readonly string[]).includes(value);
}

/** Usage checks that run before the catalog is read or any process is spawned. */
function validateInstallRequest(name: string, options: McpInstallOptions): McpInstallAgent {
  const agent = options.agent;
  if (!isMcpInstallAgent(agent)) {
    throw new ConfigurationError(
      `Unknown agent "${agent}". Supported agents: ${MCP_INSTALL_AGENTS.join(', ')}`
    );
  }
  if (name.startsWith('-')) {
    throw new ConfigurationError(`Invalid server name: ${name}`);
  }
  if (options.scope && agent === 'codex') {
    throw new ConfigurationError('codex mcp add does not support --scope');
  }
  return agent;
}

/** Find a catalog entry by name and refuse anything that is not an installable catalog server. */
function selectInstallTarget(catalog: ResolvedCatalog, name: string): InstallTarget {
  const item = findCatalogEntry(catalog, name);
  if (!item) {
    throw new ConfigurationError(
      `"${name}" is not in the MCP catalog. Run "codemie mcp list --catalog" to see installable servers; arbitrary URLs need "codemie mcp add".`
    );
  }
  const url = item.entry.url;
  if (!item.installable || !url) {
    throw new ConfigurationError(
      `"${item.entry.name}" is listed in the MCP catalog but cannot be installed: only http and sse servers with a url are supported.`
    );
  }
  return { name: item.entry.name, url };
}

async function ensureInstallProxy(): Promise<void> {
  if (!(await getCommandPath('codemie-mcp-proxy'))) {
    throw new ToolExecutionError(
      'codemie-mcp-proxy',
      'binary not found. Reinstall @codemieai/code to restore the MCP proxy binary.'
    );
  }
}

function missingAgentCli(agent: McpInstallAgent): ToolExecutionError {
  return new ToolExecutionError(
    `${agent} CLI`,
    `not found on PATH. Install it with "codemie install ${agent}".`
  );
}

async function resolveAgentCommand(agent: McpInstallAgent): Promise<{ command: string; shell: boolean }> {
  if (agent === 'claude') {
    try {
      return await resolveClaudeCommand();
    } catch {
      throw missingAgentCli(agent);
    }
  }
  const command = await getCommandPath(agent);
  if (!command) {
    throw missingAgentCli(agent);
  }
  return { command, shell: os.platform() === 'win32' };
}

/** Resolve the catalog entry and register it through the chosen agent CLI. Returns the exit code. */
async function installCatalogServer(name: string, options: McpInstallOptions): Promise<number> {
  const agent = validateInstallRequest(name, options);
  const catalog = await resolveCatalog();
  printNotices(catalog);
  const target = selectInstallTarget(catalog, name);
  await ensureInstallProxy();
  const { command, shell } = await resolveAgentCommand(agent);
  return execMcpCommand(
    command,
    shell,
    buildAddArgs(agent, target.name, target.url, options.scope)
  );
}

function createMcpInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Register a catalog MCP server through an agent CLI (codemie-mcp-proxy)')
    .argument('<name>', 'Catalog server name (see `codemie mcp list --catalog`)')
    .option('--agent <agent>', `Agent to register with (${MCP_INSTALL_AGENTS.join(', ')})`, 'claude')
    .option('--scope <scope>', 'Scope for the MCP server (claude and gemini only)')
    .action(async (name: string, options: McpInstallOptions) => {
      let exitCode: number;
      try {
        exitCode = await installCatalogServer(name, options);
      } catch (error: unknown) {
        console.error(formatErrorForUser(createErrorContext(error), { showSystem: false }));
        exitCode = 1;
      }
      process.exit(exitCode);
    });

  return command;
}

function createMcpAddCommand(): Command {
  const command = new Command('add');

  command
    .description('Register an MCP server via codemie-mcp-proxy')
    .argument('<name>', 'Name for the MCP server')
    .argument('<url>', 'MCP server URL')
    .option('--scope <scope>', 'Scope for the MCP server (e.g. project, user)')
    .action(async (name: string, url: string, options: { scope?: string }) => {
      // Validate URL early, before spawning claude
      try {
        new URL(url);
      } catch {
        console.error(`Invalid MCP server URL: ${url}`);
        process.exit(1);
      }

      // Reject names that look like flags to avoid corrupting the claude command
      if (name.startsWith('-')) {
        console.error(`Invalid server name: ${name}`);
        process.exit(1);
      }

      let claudeCommand: string;
      let useShell: boolean;
      try {
        await ensureProxyCommandExists();
        ({ command: claudeCommand, shell: useShell } = await resolveClaudeCommand());
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'proxy-not-found') {
          console.error('codemie-mcp-proxy not found. Reinstall @codemieai/code to restore the MCP proxy binary.');
          process.exit(1);
        }

        console.error('claude CLI not found. Install Claude Code: https://claude.ai/code');
        process.exit(1);
      }

      const args: string[] = ['mcp', 'add'];

      if (options.scope) {
        args.push('--scope', options.scope);
      }

      args.push(name, '--', 'codemie-mcp-proxy', url);

      await runClaudeMcpCommand(claudeCommand, useShell, args);
    });

  return command;
}

function createMcpRemoveCommand(): Command {
  const command = new Command('remove');

  command
    .description('Remove a registered MCP server')
    .argument('<name>', 'Name of the MCP server to remove')
    .option('--scope <scope>', 'Scope for the MCP server (e.g. project, user)')
    .action(async (name: string, options: { scope?: string }) => {
      // Reject names that look like flags to avoid corrupting the claude command
      if (name.startsWith('-')) {
        console.error(`Invalid server name: ${name}`);
        process.exit(1);
      }

      let claudeCommand: string;
      let useShell: boolean;
      try {
        ({ command: claudeCommand, shell: useShell } = await resolveClaudeCommand());
      } catch {
        console.error('claude CLI not found. Install Claude Code: https://claude.ai/code');
        process.exit(1);
      }

      const args: string[] = ['mcp', 'remove'];

      if (options.scope) {
        args.push('--scope', options.scope);
      }

      args.push(name);

      await runClaudeMcpCommand(claudeCommand, useShell, args);
    });

  return command;
}

function describeAuth(entry: CanonicalMcpEntry): string {
  return entry.oauth || entry.auth === 'oauth' ? 'oauth' : 'none';
}

function formatCatalogEntry(item: CatalogEntry): string[] {
  const { entry, installable } = item;
  const status = installable ? 'installable' : 'not installable';
  const lines = [`${entry.name}  [${entry.transport}, auth: ${describeAuth(entry)}]  ${status}`];
  if (entry.url) lines.push(`  url: ${entry.url}`);
  if (entry.description) lines.push(`  ${entry.description}`);
  return lines;
}

function printNotices(catalog: ResolvedCatalog): void {
  for (const notice of catalog.notices) {
    console.warn(notice);
  }
}

function printCatalog(catalog: ResolvedCatalog): void {
  printNotices(catalog);
  if (catalog.entries.length === 0) {
    console.log('No MCP servers are available in the catalog.');
    return;
  }
  for (const item of catalog.entries) {
    for (const line of formatCatalogEntry(item)) {
      console.log(line);
    }
  }
}

function createMcpListCommand(): Command {
  const command = new Command('list');

  command
    .description('List registered MCP servers')
    .option('--catalog', 'List the managed MCP catalog available to `mcp install`')
    .action(async (options: { catalog?: boolean }) => {
    if (options.catalog) {
      printCatalog(await resolveCatalog());
      return;
    }

      let claudeCommand: string;
      let useShell: boolean;
      try {
        ({ command: claudeCommand, shell: useShell } = await resolveClaudeCommand());
      } catch {
        console.error('claude CLI not found. Install Claude Code: https://claude.ai/code');
        process.exit(1);
      }

      await runClaudeMcpCommand(claudeCommand, useShell, ['mcp', 'list']);
    });

  return command;
}

export function createMcpCommand(): Command {
  const mcp = new Command('mcp').description('Manage MCP servers');
  mcp.addCommand(createMcpAddCommand());
  mcp.addCommand(createMcpRemoveCommand());
  mcp.addCommand(createMcpListCommand());
  mcp.addCommand(createMcpInstallCommand());
  return mcp;
}
