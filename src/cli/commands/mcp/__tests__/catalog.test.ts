/**
 * MCP catalog resolver tests
 * @group unit
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { CanonicalMcpEntry } from '@/cli/commands/proxy/connectors/managed-mcp-remote.js';
import type { CodeMieConfigOptions } from '@/utils/config.js';

vi.mock('@/cli/commands/proxy/connectors/managed-mcp-remote.js', () => ({
  fetchManagedMcpServers: vi.fn(),
}));

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn() },
}));

const CODEMIE_URL = 'https://codemie.example.com';

function configWith(codeMieUrl?: string): CodeMieConfigOptions {
  return { codeMieUrl } as unknown as CodeMieConfigOptions;
}

describe('catalog', () => {
  let fetchManagedMcpServers: ReturnType<typeof vi.fn>;
  let ConfigLoader: { load: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    const remote = await import('@/cli/commands/proxy/connectors/managed-mcp-remote.js');
    const config = await import('@/utils/config.js');
    fetchManagedMcpServers = vi.mocked(remote.fetchManagedMcpServers) as unknown as ReturnType<typeof vi.fn>;
    ConfigLoader = config.ConfigLoader as unknown as { load: ReturnType<typeof vi.fn> };
    ConfigLoader.load.mockResolvedValue(configWith(CODEMIE_URL));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('resolveCatalog', () => {
    it('uses the bundled defaults plus a notice when the backend fetch returns null', async () => {
      fetchManagedMcpServers.mockResolvedValue(null);
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      const catalog = await resolveCatalog();

      expect(catalog.entries.map((c) => c.entry.name)).toContain('Notion');
      expect(catalog.notices.length).toBeGreaterThan(0);
    });

    it('requests the catalog for the claude-desktop client id and the profile URL', async () => {
      fetchManagedMcpServers.mockResolvedValue(null);
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      await resolveCatalog();

      expect(fetchManagedMcpServers).toHaveBeenCalledWith('claude-desktop', CODEMIE_URL);
    });

    it('returns an empty catalog when the backend returns an empty list', async () => {
      fetchManagedMcpServers.mockResolvedValue([]);
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      const catalog = await resolveCatalog();

      expect(catalog.entries).toEqual([]);
    });

    it('lets the backend entry win a name collision with a bundled default', async () => {
      const backend: CanonicalMcpEntry[] = [
        { name: 'Notion', transport: 'http', url: 'https://internal.example.com/notion', oauth: false },
      ];
      fetchManagedMcpServers.mockResolvedValue(backend);
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      const catalog = await resolveCatalog();
      const notion = catalog.entries.filter((c) => c.entry.name === 'Notion');

      expect(notion).toHaveLength(1);
      expect(notion[0].entry.url).toBe('https://internal.example.com/notion');
    });

    it('keeps bundled defaults that the backend does not collide with', async () => {
      fetchManagedMcpServers.mockResolvedValue([
        { name: 'Acme', transport: 'http', url: 'https://acme.example.com/mcp', oauth: true },
      ]);
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      const catalog = await resolveCatalog();
      const names = catalog.entries.map((c) => c.entry.name);

      expect(names).toEqual(expect.arrayContaining(['Acme', 'Linear']));
    });

    it('marks a stdio backend entry as not installable', async () => {
      fetchManagedMcpServers.mockResolvedValue([
        { name: 'LocalTool', transport: 'stdio', oauth: false },
      ]);
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      const catalog = await resolveCatalog();
      const local = catalog.entries.find((c) => c.entry.name === 'LocalTool');

      expect(local?.installable).toBe(false);
    });

    it('marks an sse backend entry with a url as installable', async () => {
      fetchManagedMcpServers.mockResolvedValue([
        { name: 'Streamer', transport: 'sse', url: 'https://stream.example.com/sse', oauth: false },
      ]);
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      const catalog = await resolveCatalog();
      const streamer = catalog.entries.find((c) => c.entry.name === 'Streamer');

      expect(streamer?.installable).toBe(true);
    });

    it('returns bundled defaults with a notice and skips fetch when no profile URL is configured', async () => {
      ConfigLoader.load.mockResolvedValue(configWith(undefined));
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      const catalog = await resolveCatalog();

      expect(fetchManagedMcpServers).not.toHaveBeenCalled();
      expect(catalog.entries.map((c) => c.entry.name)).toContain('Notion');
      expect(catalog.notices.length).toBeGreaterThan(0);
    });

    it('returns bundled defaults with a notice and skips fetch when configuration cannot be loaded', async () => {
      ConfigLoader.load.mockRejectedValue(new Error('unreadable config'));
      const { resolveCatalog } = await import('@/cli/commands/mcp/catalog.js');

      const catalog = await resolveCatalog();

      expect(fetchManagedMcpServers).not.toHaveBeenCalled();
      expect(catalog.entries.map((c) => c.entry.name)).toContain('Notion');
      expect(catalog.notices.length).toBeGreaterThan(0);
    });
  });

  describe('findCatalogEntry', () => {
    it('finds a bundled entry by an upper-case name', async () => {
      fetchManagedMcpServers.mockResolvedValue(null);
      const { resolveCatalog, findCatalogEntry } = await import('@/cli/commands/mcp/catalog.js');
      const catalog = await resolveCatalog();

      const found = findCatalogEntry(catalog, 'NOTION');

      expect(found?.entry.name).toBe('Notion');
    });

    it('returns undefined for a name that is not in the catalog', async () => {
      fetchManagedMcpServers.mockResolvedValue(null);
      const { resolveCatalog, findCatalogEntry } = await import('@/cli/commands/mcp/catalog.js');
      const catalog = await resolveCatalog();

      expect(findCatalogEntry(catalog, 'does-not-exist')).toBeUndefined();
    });
  });
});
