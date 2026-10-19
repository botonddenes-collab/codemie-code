import {
  fetchManagedMcpServers,
  type CanonicalMcpEntry,
} from '@/cli/commands/proxy/connectors/managed-mcp-remote.js';
import {
  DEFAULT_MANAGED_MCP_SERVERS,
  bundledCanonicalDefaults,
  collidesWithManagedEntry,
  type ManagedMcpServerEntry,
} from '@/cli/commands/proxy/connectors/managed-mcp-catalog.js';
import { bundledOnFailedFetch } from '@/cli/commands/proxy/connectors/managed-mcp-fallback.js';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

/** Client id the managed MCP catalog is requested for (Desktop's id, reused by the CLI). */
export const MCP_CATALOG_CLIENT_ID = 'claude-desktop';

/** The resolved catalog plus human-readable notices about how it was built. */
export interface ResolvedCatalog {
  entries: CanonicalMcpEntry[];
  notices: string[];
}

const NOTICE_NO_PROFILE =
  'No CodeMie profile is configured; showing the bundled MCP catalog only. Run `codemie setup` to include organization servers.';
const NOTICE_FETCH_UNAVAILABLE =
  'Organization MCP catalog is unavailable (no SSO session); showing the bundled MCP catalog only.';
const NOTICE_CONFIG_UNREADABLE =
  'CodeMie configuration could not be read; showing the bundled MCP catalog only.';

/** Shape a backend entry takes when it passes through the shared merge. */
function canonicalToManaged(entry: CanonicalMcpEntry): ManagedMcpServerEntry {
  return {
    name: entry.name,
    url: entry.url ?? '',
    transport: entry.transport === 'sse' ? 'sse' : 'http',
    oauth: entry.oauth,
  };
}

/**
 * Merge the organization catalog over the bundled defaults using the same rules
 * Claude Desktop uses: the backend wins a name or endpoint collision. Every backend
 * entry takes part in the collision test whatever its transport, so a stdio entry
 * cannot sit beside the bundled default it shadows.
 */
function mergeWithBundled(orgEntries: CanonicalMcpEntry[]): CanonicalMcpEntry[] {
  const orgManaged = orgEntries.map(canonicalToManaged);
  const keptDefaults = DEFAULT_MANAGED_MCP_SERVERS.filter(
    (bundled) => !orgManaged.some((org) => collidesWithManagedEntry(bundled, org)),
  );
  return [...bundledCanonicalDefaults(keptDefaults), ...orgEntries];
}

function bundledOnly(notice: string): ResolvedCatalog {
  return {
    entries: bundledCanonicalDefaults(),
    notices: [notice],
  };
}

/**
 * Resolve the MCP catalog for the active profile.
 *
 * - No readable profile or no `codeMieUrl`: bundled defaults plus a notice, no fetch.
 * - Backend returns `null` (no SSO session or fetch failure): bundled defaults plus a notice.
 * - Backend returns `[]`: an empty catalog.
 * - Backend returns entries: merged over the bundled defaults, backend winning collisions.
 */
export async function resolveCatalog(): Promise<ResolvedCatalog> {
  let codeMieUrl: string | undefined;
  try {
    const config = await ConfigLoader.load();
    codeMieUrl = config.codeMieUrl;
  } catch (error) {
    logger.debug(
      '[mcp] Catalog configuration unreadable',
      ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) }),
    );
    return bundledOnly(NOTICE_CONFIG_UNREADABLE);
  }

  if (!codeMieUrl) {
    return bundledOnly(NOTICE_NO_PROFILE);
  }

  const orgEntries = await fetchManagedMcpServers(MCP_CATALOG_CLIENT_ID, codeMieUrl);
  if (orgEntries === null) {
    const fallback = bundledOnFailedFetch(NOTICE_FETCH_UNAVAILABLE);
    return {
      entries: bundledCanonicalDefaults(fallback.defaults),
      notices: fallback.notice ? [fallback.notice] : [],
    };
  }
  if (orgEntries.length === 0) {
    return { entries: [], notices: [] };
  }
  return { entries: mergeWithBundled(orgEntries), notices: [] };
}

/** Case-insensitive exact lookup of a catalog entry by its canonical name. */
export function findCatalogEntry(catalog: ResolvedCatalog, name: string): CanonicalMcpEntry | undefined {
  const wanted = name.toLowerCase();
  return catalog.entries.find((candidate) => candidate.name.toLowerCase() === wanted);
}
