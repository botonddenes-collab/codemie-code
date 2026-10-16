import managedMcpServers from './desktop-managed-mcp-servers.json' with { type: 'json' };
import type { CanonicalMcpEntry, McpOAuthConfig } from '@/cli/commands/proxy/connectors/managed-mcp-remote.js';

export interface ManagedMcpServerEntry {
  name: string;
  url: string;
  transport?: 'http' | 'sse';
  /**
   * `true`/`false` is the legacy flag Claude Desktop already understood; an
   * {@link McpOAuthConfig} is the structured client configuration the backend
   * now supplies. The CLI forwards it verbatim — Desktop runs the flow.
   */
  oauth?: McpOAuthConfig | boolean;
}

export const DEFAULT_MANAGED_MCP_SERVERS =
  managedMcpServers as readonly ManagedMcpServerEntry[];

/** Canonical shape of bundled defaults, the list the MCP catalog falls back to. */
export function bundledCanonicalDefaults(
  defaults: readonly ManagedMcpServerEntry[] = DEFAULT_MANAGED_MCP_SERVERS,
): CanonicalMcpEntry[] {
  return defaults.map((entry) => ({
    name: entry.name,
    transport: entry.transport ?? 'http',
    url: entry.url,
    auth: entry.oauth ? 'oauth' : 'none',
    oauth: entry.oauth,
  }));
}

/**
 * Copy a managed entry, including its nested oauth object.
 *
 * A shallow `{ ...entry }` would share the oauth object with
 * DEFAULT_MANAGED_MCP_SERVERS — a readonly module-level constant that lives for
 * the whole process — so a later mutation of the written config would corrupt
 * the bundled defaults for every subsequent run.
 */
export function cloneManagedEntry(entry: ManagedMcpServerEntry): ManagedMcpServerEntry {
  const copy: ManagedMcpServerEntry = { ...entry };
  if (entry.oauth !== undefined && typeof entry.oauth === 'object') {
    copy.oauth = { ...entry.oauth };
  }
  return copy;
}

/** True when the entry carries usable OAuth information (structured config or the legacy flag). */
function hasManagedOAuth(entry: ManagedMcpServerEntry): boolean {
  return entry.oauth === true || (typeof entry.oauth === 'object' && entry.oauth !== null);
}

/**
 * URL equality between two managed entries, compared verbatim. Managed entries
 * come from controlled sources (DEFAULT_MANAGED_MCP_SERVERS or the backend
 * catalog), so this is intentionally exact — no trailing-slash or host-case
 * normalization. That normalization is a known, separately-tracked gap, not
 * something this comparison closes.
 */
function sameManagedEndpoint(a: ManagedMcpServerEntry, b: ManagedMcpServerEntry): boolean {
  return a.url === b.url;
}

/** Case-insensitive name equality between two managed entries. */
function sameManagedName(a: ManagedMcpServerEntry, b: ManagedMcpServerEntry): boolean {
  return a.name.toLowerCase() === b.name.toLowerCase();
}

/**
 * Collision test between a bundled default and a backend entry: a shared name
 * OR a shared endpoint, mirroring reconcileManagedMcpServers, where both sides
 * come from controlled sources. Defined in terms of {@link sameManagedName} and
 * {@link sameManagedEndpoint} so the wide and narrow tests cannot drift apart.
 */
export function collidesWithManagedEntry(a: ManagedMcpServerEntry, b: ManagedMcpServerEntry): boolean {
  return sameManagedName(a, b) || sameManagedEndpoint(a, b);
}

/** A backend entry published at the same endpoint as a bundled default that declares OAuth, without OAuth of its own. */
export interface ManagedOauthDowngrade {
  /** The bundled default that was displaced. */
  defaultName: string;
  /** The backend entry that displaced it, at weaker auth. */
  backendName: string;
  /** The endpoint the backend entry was published at. */
  url: string;
}

export interface ManagedMcpMergeResult {
  /** The entries CodeMie owns this run, defaults first, all freshly cloned. */
  managed: ManagedMcpServerEntry[];
  /** Collisions where the backend entry resolved to weaker auth than the default it displaced. */
  oauthDowngrades: ManagedOauthDowngrade[];
  /** Names of bundled defaults dropped because an org entry collided with them. */
  displacedDefaults: string[];
}

/**
 * Merge the bundled public defaults with the org catalog so a server the backend
 * also publishes is written exactly once.
 *
 * The BACKEND wins every collision outright: it is authoritative for both the
 * name and the endpoint, and its entry is written exactly as published — the CLI
 * is a courier, not a policy layer, so no oauth value is ever rewritten. A
 * collision that lowers auth relative to the bundled default it displaces is
 * logged (see {@link ManagedOauthDowngrade}), never corrected.
 */
export function mergeManagedMcpServers(
  defaults: readonly ManagedMcpServerEntry[],
  org: readonly ManagedMcpServerEntry[],
): ManagedMcpMergeResult {
  // Single pass over defaults: keptDefaults and displacedDefaults are
  // complements of the same collidesWithManagedEntry test, so they can never
  // disagree about which bundled default survived.
  const keptDefaults: ManagedMcpServerEntry[] = [];
  const displacedDefaults: string[] = [];
  for (const bundled of defaults) {
    if (org.some((entry) => collidesWithManagedEntry(bundled, entry))) {
      displacedDefaults.push(bundled.name);
    } else {
      keptDefaults.push(bundled);
    }
  }

  // Downgrade reporting is scoped to sameManagedEndpoint, not the wider
  // collidesWithManagedEntry used for displacement above — a default's oauth
  // describes ITS endpoint, not its name, so a backend entry that merely
  // reuses the name at a different endpoint is not a downgrade. Because
  // collidesWithManagedEntry is defined as sameManagedName(a, b) ||
  // sameManagedEndpoint(a, b), a reported downgrade is by construction a
  // strict subset of a displacement: an endpoint collision can never displace
  // a default without also being reportable. Do not widen this back to
  // collidesWithManagedEntry.
  const oauthDowngrades: ManagedOauthDowngrade[] = [];
  for (const entry of org) {
    if (hasManagedOAuth(entry)) continue;
    // At most one record per org entry — take the first matching default, so
    // an entry is never double-counted if it happened to match more than one.
    const downgradedDefault = defaults.find(
      (bundled) => hasManagedOAuth(bundled) && sameManagedEndpoint(bundled, entry),
    );
    if (!downgradedDefault) continue;
    oauthDowngrades.push({
      defaultName: downgradedDefault.name,
      backendName: entry.name,
      url: entry.url,
    });
  }

  return {
    managed: [...keptDefaults, ...org].map(cloneManagedEntry),
    oauthDowngrades,
    displacedDefaults,
  };
}
