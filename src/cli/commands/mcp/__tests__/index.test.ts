/**
 * MCP command tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';

vi.mock('../../../../utils/exec.js', () => ({
  exec: vi.fn(),
}));

vi.mock('../../../../utils/processes.js', () => ({
  getCommandPath: vi.fn(),
}));

vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn().mockReturnValue('/home/test/.local/bin/claude'),
}));

// The catalog resolver loads the CodeMie config, which the partial utils mocks above do not provide.
vi.mock('../catalog.js', () => ({
  resolveCatalog: vi.fn(),
  findCatalogEntry: vi.fn(
    (catalog: { entries: Array<{ entry: { name: string } }> }, name: string) =>
      catalog.entries.find((candidate) => candidate.entry.name.toLowerCase() === name.toLowerCase()),
  ),
}));

// The fast-path claude lookup is only attempted on non-Windows; the fallback shell flag
// mirrors os.platform() === 'win32' either way, so compute the expectation from the real os module.
const expectedShell = os.platform() === 'win32';

describe('mcp command', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  /** Makes the ~/.local/bin/claude fast-path check fail so resolution falls back to PATH lookup. */
  async function mockClaudeResolved(mcpResultCode = 0) {
    const { exec } = await import('../../../../utils/exec.js');
    const { getCommandPath } = await import('../../../../utils/processes.js');

    vi.mocked(getCommandPath).mockImplementation(async (command: string) => {
      if (command === 'claude') return '/usr/local/bin/claude';
      if (command === 'codemie-mcp-proxy') return '/usr/local/bin/codemie-mcp-proxy';
      return null;
    });

    vi.mocked(exec).mockImplementation(async (_command: string, args: string[] = []) => {
      if (args.includes('--version')) {
        throw new Error('ENOENT: claude not found at fast path');
      }
      return { code: mcpResultCode, stdout: '', stderr: '' };
    });

    return { exec, getCommandPath };
  }

  describe('add', () => {
    it('registers the MCP server via codemie-mcp-proxy and exits with the claude exit code', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'https://example.com/mcp'], { from: 'user' })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'add', 'my-server', '--', 'codemie-mcp-proxy', 'https://example.com/mcp'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('inserts --scope before the server name when provided', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'https://example.com/mcp', '--scope', 'project'], {
          from: 'user',
        })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'add', '--scope', 'project', 'my-server', '--', 'codemie-mcp-proxy', 'https://example.com/mcp'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('rejects an invalid MCP server URL before touching claude', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'not-a-url'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Invalid MCP server URL: not-a-url');
      expect(exec).not.toHaveBeenCalled();
    });

    it('rejects a server name that looks like a flag', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', '--', '-badname', 'https://example.com/mcp'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Invalid server name: -badname');
      expect(exec).not.toHaveBeenCalled();
    });

    it('errors out when codemie-mcp-proxy is not installed', async () => {
      const { exec, getCommandPath } = await mockClaudeResolved(0);
      vi.mocked(getCommandPath).mockImplementation(async (command: string) => {
        if (command === 'claude') return '/usr/local/bin/claude';
        return null;
      });
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'https://example.com/mcp'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'codemie-mcp-proxy not found. Reinstall @codemieai/code to restore the MCP proxy binary.'
      );
      expect(exec).not.toHaveBeenCalled();
    });

    it('errors out when the claude CLI cannot be found', async () => {
      const { getCommandPath } = await mockClaudeResolved(0);
      vi.mocked(getCommandPath).mockImplementation(async (command: string) => {
        if (command === 'codemie-mcp-proxy') return '/usr/local/bin/codemie-mcp-proxy';
        return null;
      });
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'https://example.com/mcp'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('claude CLI not found. Install Claude Code: https://claude.ai/code');
    });
  });

  describe('remove', () => {
    it('removes a registered MCP server by name', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['remove', 'my-server'], { from: 'user' })).rejects.toThrow(
        /^process\.exit:/
      );

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'remove', 'my-server'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('forwards --scope to the underlying claude mcp remove call', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['remove', 'my-server', '--scope', 'project'], { from: 'user' })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'remove', '--scope', 'project', 'my-server'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('rejects a server name that looks like a flag', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['remove', '--', '-badname'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Invalid server name: -badname');
      expect(exec).not.toHaveBeenCalled();
    });

    it('errors out when the claude CLI cannot be found', async () => {
      const { getCommandPath } = await mockClaudeResolved(0);
      vi.mocked(getCommandPath).mockResolvedValue(null);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['remove', 'my-server'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('claude CLI not found. Install Claude Code: https://claude.ai/code');
    });
  });

  describe('list', () => {
    it('lists registered MCP servers', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'list'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('errors out when the claude CLI cannot be found', async () => {
      const { getCommandPath } = await mockClaudeResolved(0);
      vi.mocked(getCommandPath).mockResolvedValue(null);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('claude CLI not found. Install Claude Code: https://claude.ai/code');
    });

    it('propagates the exit code returned by the claude CLI', async () => {
      await mockClaudeResolved(3);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 3);
    });

    it('exits 1 when claude cannot be spawned (ENOENT)', async () => {
      const { exec } = await mockClaudeResolved(0);
      vi.mocked(exec).mockImplementation(async (_command: string, args: string[] = []) => {
        if (args.includes('--version')) {
          throw new Error('ENOENT: claude not found at fast path');
        }
        throw new Error('spawn claude ENOENT');
      });
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('claude CLI not found. Install Claude Code: https://claude.ai/code');
    });

    it('extracts the exit code from a non-interactive rejection message', async () => {
      const { exec } = await mockClaudeResolved(0);
      vi.mocked(exec).mockImplementation(async (_command: string, args: string[] = []) => {
        if (args.includes('--version')) {
          throw new Error('ENOENT: claude not found at fast path');
        }
        throw new Error('Command exited with code 7');
      });
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow('process.exit:7');
    });
  });

  describe('list --catalog', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    const fixtureCatalog = {
      entries: [
        {
          entry: {
            name: 'Notion',
            transport: 'http',
            url: 'https://mcp.notion.com/mcp',
            auth: 'oauth',
            oauth: true,
            description: 'Notion workspace',
          },
          installable: true,
        },
        {
          entry: { name: 'LocalTool', transport: 'stdio', auth: 'none', oauth: false },
          installable: false,
        },
      ],
      notices: ['Organization MCP catalog is unavailable (no SSO session); showing the bundled MCP catalog only.'],
    };

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    async function mockCatalog(catalog: unknown) {
      const catalogModule = await import('../catalog.js');
      vi.mocked(catalogModule.resolveCatalog).mockResolvedValue(catalog as never);
      return catalogModule;
    }

    function printedLines(): string {
      return consoleLogSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    }

    it('prints each catalog entry with its transport, auth, url and description', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockCatalog(fixtureCatalog);
      const { createMcpCommand } = await import('../index.js');

      await createMcpCommand().parseAsync(['list', '--catalog'], { from: 'user' });

      const output = printedLines();
      expect(output).toContain('Notion');
      expect(output).toContain('http');
      expect(output).toContain('oauth');
      expect(output).toContain('https://mcp.notion.com/mcp');
      expect(output).toContain('Notion workspace');
      expect(exec).not.toHaveBeenCalled();
    });

    it('marks a stdio entry as not installable', async () => {
      await mockClaudeResolved(0);
      await mockCatalog(fixtureCatalog);
      const { createMcpCommand } = await import('../index.js');

      await createMcpCommand().parseAsync(['list', '--catalog'], { from: 'user' });

      const localToolLine = consoleLogSpy.mock.calls
        .map((call) => call.join(' '))
        .find((line) => line.includes('LocalTool'));
      expect(localToolLine).toContain('not installable');
    });

    it('prints the catalog notices as warnings', async () => {
      await mockClaudeResolved(0);
      await mockCatalog(fixtureCatalog);
      const { createMcpCommand } = await import('../index.js');

      await createMcpCommand().parseAsync(['list', '--catalog'], { from: 'user' });

      expect(consoleWarnSpy).toHaveBeenCalledWith(fixtureCatalog.notices[0]);
    });

    it('prints an empty-catalog message when the catalog has no entries', async () => {
      await mockClaudeResolved(0);
      await mockCatalog({ entries: [], notices: [] });
      const { createMcpCommand } = await import('../index.js');

      await createMcpCommand().parseAsync(['list', '--catalog'], { from: 'user' });

      expect(printedLines()).toContain('No MCP servers are available');
    });

    it('does not resolve or run the claude CLI', async () => {
      const { getCommandPath } = await mockClaudeResolved(0);
      await mockCatalog(fixtureCatalog);
      const { createMcpCommand } = await import('../index.js');

      await createMcpCommand().parseAsync(['list', '--catalog'], { from: 'user' });

      expect(getCommandPath).not.toHaveBeenCalledWith('claude');
    });
  });

  describe('install', () => {
    const NOTION_URL = 'https://mcp.notion.com/mcp';
    const PROXY_PATH = '/usr/local/bin/codemie-mcp-proxy';

    const installFixture = {
      entries: [
        {
          entry: { name: 'Notion', transport: 'http', url: NOTION_URL, auth: 'oauth', oauth: true },
          installable: true,
        },
        {
          entry: { name: 'LocalTool', transport: 'stdio', auth: 'none', oauth: false },
          installable: false,
        },
      ],
      notices: [],
    };

    async function mockInstallCatalog(catalog: unknown = installFixture) {
      const catalogModule = await import('../catalog.js');
      vi.mocked(catalogModule.resolveCatalog).mockResolvedValue(catalog as never);
    }

    async function mockCommandPaths(paths: Record<string, string | null>) {
      const { getCommandPath } = await import('../../../../utils/processes.js');
      vi.mocked(getCommandPath).mockImplementation(async (command: string) => paths[command] ?? null);
    }

    /** Everything written to console.error, flattened and whitespace-normalized (the formatter wraps lines). */
    function errorOutput(): string {
      return consoleErrorSpy.mock.calls
        .map((call) => call.join(' '))
        .join(' ')
        .replace(/\s+/g, ' ');
    }

    it('registers the catalog server under its canonical name through claude by default', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion'], { from: 'user' })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'add', 'Notion', '--', 'codemie-mcp-proxy', NOTION_URL],
        { interactive: true, shell: expectedShell }
      );
    });

    it.each([
      ['bad&name', 'https://acme.example.com/mcp'],
      ['Acme Tools', 'https://acme.example.com/mcp'],
    ])('refuses the unsafe catalog name "%s" without executing anything', async (name, url) => {
      const { exec } = await mockClaudeResolved(0);
      await mockInstallCatalog({
        entries: [{ entry: { name, transport: 'http', url, auth: 'none', oauth: false }, installable: true }],
        notices: [],
      });
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', name], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(errorOutput()).toContain('unsafe');
      expect(exec).not.toHaveBeenCalled();
    });

    it.each([
      ['https://acme.example.com/mcp?a=1&b=2'],
      ['ftp://acme.example.com/mcp'],
    ])('refuses the unsafe catalog url "%s" without executing anything', async (url) => {
      const { exec } = await mockClaudeResolved(0);
      await mockInstallCatalog({
        entries: [{ entry: { name: 'Acme', transport: 'http', url, auth: 'none', oauth: false }, installable: true }],
        notices: [],
      });
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'acme'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(errorOutput()).toContain('unsafe');
      expect(exec).not.toHaveBeenCalled();
    });

    it('registers through codex mcp add without a scope flag when --agent=codex', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockCommandPaths({ codex: '/usr/local/bin/codex', 'codemie-mcp-proxy': PROXY_PATH });
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion', '--agent=codex'], { from: 'user' })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/codex',
        ['mcp', 'add', 'Notion', '--', 'codemie-mcp-proxy', NOTION_URL],
        { interactive: true, shell: expectedShell }
      );
    });

    it('registers through gemini mcp add when --agent=gemini', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockCommandPaths({ gemini: '/usr/local/bin/gemini', 'codemie-mcp-proxy': PROXY_PATH });
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion', '--agent=gemini'], { from: 'user' })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/gemini',
        ['mcp', 'add', 'Notion', 'codemie-mcp-proxy', NOTION_URL],
        { interactive: true, shell: expectedShell }
      );
    });

    it('propagates the exit code returned by the agent CLI', async () => {
      await mockClaudeResolved(4);
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion'], { from: 'user' })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 4);
    });

    it('rejects an unknown agent without executing anything', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion', '--agent=foo'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(errorOutput()).toContain('Unknown agent');
      expect(exec).not.toHaveBeenCalled();
    });

    it.each([['https://evil.example/mcp'], ['nosuch']])(
      'refuses "%s" because it is not in the catalog, pointing to list --catalog and mcp add',
      async (name) => {
        const { exec } = await mockClaudeResolved(0);
        await mockInstallCatalog();
        const { createMcpCommand } = await import('../index.js');

        await expect(
          createMcpCommand().parseAsync(['install', name], { from: 'user' })
        ).rejects.toThrow('process.exit:1');

        expect(errorOutput()).toContain('list --catalog');
        expect(errorOutput()).toContain('mcp add');
        expect(exec).not.toHaveBeenCalled();
      }
    );

    it('refuses a catalog entry that is not installable', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'localtool'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(errorOutput()).toContain('cannot be installed');
      expect(exec).not.toHaveBeenCalled();
    });

    it('refuses a bundled name when the backend catalog is empty', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockInstallCatalog({ entries: [], notices: [] });
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(exec).not.toHaveBeenCalled();
    });

    it('rejects a server name that starts with a dash', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', '--', '-badname'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(exec).not.toHaveBeenCalled();
    });

    it('rejects --scope for codex, which has no scope flag', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockCommandPaths({ codex: '/usr/local/bin/codex', 'codemie-mcp-proxy': PROXY_PATH });
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion', '--agent=codex', '--scope', 'user'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(exec).not.toHaveBeenCalled();
    });

    it('errors out naming the proxy when codemie-mcp-proxy is missing', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockCommandPaths({ claude: '/usr/local/bin/claude' });
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(errorOutput()).toContain('codemie-mcp-proxy');
      expect(exec).not.toHaveBeenCalled();
    });

    it('errors out naming the agent and codemie install when its CLI is missing', async () => {
      const { exec } = await mockClaudeResolved(0);
      await mockCommandPaths({ 'codemie-mcp-proxy': PROXY_PATH });
      await mockInstallCatalog();
      const { createMcpCommand } = await import('../index.js');

      await expect(
        createMcpCommand().parseAsync(['install', 'notion', '--agent=codex'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(errorOutput()).toContain('codex');
      expect(errorOutput()).toContain('codemie install codex');
      expect(exec).not.toHaveBeenCalled();
    });
  });
});
