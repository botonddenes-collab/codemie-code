import {
  fetchManagedMcpServers,
  type CanonicalMcpEntry,
} from '@/cli/commands/proxy/connectors/managed-mcp-remote.js';
import {
  DEFAULT_MANAGED_MCP_SERVERS,
  mergeManagedMcpServers,
  type ManagedMcpServerEntry,
} from '@/cli/commands/proxy/connectors/managed-mcp-catalog.js';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

/** Client id the managed MCP catalog is requested for (Desktop's id, reused by the CLI). */
export const MCP_CATALOG_CLIENT_ID = 'claude-desktop';

/** One catalog entry and whether `mcp install` may register it. */
export interface CatalogEntry {
  entry: CanonicalMcpEntry;
  installable: boolean;
}

/** The resolved catalog plus human-readable notices about how it was built. */
export interface ResolvedCatalog {
  entries: CatalogEntry[];
  notices: string[];
}

const NOTICE_NO_PROFILE =
  'No CodeMie profile is configured; showing the bundled MCP catalog only. Run `codemie setup` to include organization servers.';
const NOTICE_FETCH_UNAVAILABLE =
  'Organization MCP catalog is unavailable (no SSO session); showing the bundled MCP catalog only.';
const NOTICE_CONFIG_UNREADABLE =
  'CodeMie configuration could not be read; showing the bundled MCP catalog only.';

/** Convert a bundled default into the canonical shape the catalog works with. */
function bundledToCanonical(entry: ManagedMcpServerEntry): CanonicalMcpEntry {
  return {
    name: entry.name,
    transport: entry.transport ?? 'http',
    url: entry.url,
    auth: entry.oauth ? 'oauth' : 'none',
    oauth: entry.oauth,
  };
}

/** Only http/sse entries that carry a url can be registered through the proxy. */
function isInstallable(entry: CanonicalMcpEntry): boolean {
  return (
    (entry.transport === 'http' || entry.transport === 'sse') &&
    typeof entry.url === 'string' &&
    entry.url.length > 0
  );
}

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
 * Find the canonical entry a merged managed entry came from. The merge clones
 * its inputs and drops fields such as description, so the source is looked up
 * again by name and url; the fallback is only reached for a bundled default.
 */
function sourceFor(managed: ManagedMcpServerEntry, sources: CanonicalMcpEntry[]): CanonicalMcpEntry {
  const match = sources.find(
    (source) =>
      source.name.toLowerCase() === managed.name.toLowerCase() && source.url === managed.url,
  );
  return match ?? bundledToCanonical(managed);
}

/**
 * Merge the organization catalog over the bundled defaults using the same rules
 * Claude Desktop uses: the backend wins a name or endpoint collision. Non-http/sse
 * backend entries are carried through as listed-but-not-installable.
 */
function mergeWithBundled(orgEntries: CanonicalMcpEntry[]): CanonicalMcpEntry[] {
  const installableOrg = orgEntries.filter(isInstallable);
  const passThrough = orgEntries.filter((entry) => !isInstallable(entry));
  const sources = [...installableOrg, ...DEFAULT_MANAGED_MCP_SERVERS.map(bundledToCanonical)];
  const { managed } = mergeManagedMcpServers(
    DEFAULT_MANAGED_MCP_SERVERS,
    installableOrg.map(canonicalToManaged),
  );
  return [...managed.map((entry) => sourceFor(entry, sources)), ...passThrough];
}

function toCatalogEntries(entries: CanonicalMcpEntry[]): CatalogEntry[] {
  return entries.map((entry) => ({ entry, installable: isInstallable(entry) }));
}

function bundledOnly(notice: string): ResolvedCatalog {
  return {
    entries: toCatalogEntries(DEFAULT_MANAGED_MCP_SERVERS.map(bundledToCanonical)),
    notices: [notice],
  };
}

/**
 * Resolve the MCP catalog for the active profile.
 *
 * - No readable profile or no `codeMieUrl`: bundled defaults plus a notice, no fetch.
 * - Backend returns `null` (no SSO session or fetch failure): bundled defaults plus a notice.
 * - Backend returns `[]`: an empty catalog, so nothing is installable.
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
    return bundledOnly(NOTICE_FETCH_UNAVAILABLE);
  }
  if (orgEntries.length === 0) {
    return { entries: [], notices: [] };
  }
  return { entries: toCatalogEntries(mergeWithBundled(orgEntries)), notices: [] };
}

/** Case-insensitive exact lookup of a catalog entry by its canonical name. */
export function findCatalogEntry(catalog: ResolvedCatalog, name: string): CatalogEntry | undefined {
  const wanted = name.toLowerCase();
  return catalog.entries.find((candidate) => candidate.entry.name.toLowerCase() === wanted);
}
