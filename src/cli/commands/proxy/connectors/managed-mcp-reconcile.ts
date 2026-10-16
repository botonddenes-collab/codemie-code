import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { isValidOAuthConfig, type CanonicalMcpEntry, type McpOAuthConfig } from './managed-mcp-remote.js';
import { DEFAULT_MANAGED_MCP_SERVERS, cloneManagedEntry, type ManagedMcpServerEntry } from './managed-mcp-catalog.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getManagedMcpServerName(server: unknown): string | undefined {
  if (!isRecord(server)) return undefined;
  return typeof server.name === 'string' ? server.name : undefined;
}

function getManagedMcpServerUrl(server: unknown): string | undefined {
  if (!isRecord(server)) return undefined;
  return typeof server.url === 'string' ? server.url : undefined;
}

/**
 * Outcome of reading a stored `managedMcpServers` value.
 *
 * `parsed: false` means the value was PRESENT but unreadable — which callers that
 * reason about what the config already holds must not confuse with an empty list.
 */
type ParsedServerList =
  | { parsed: true; servers: unknown[] }
  | { parsed: false };

function parseManagedServerList(value: unknown): ParsedServerList {
  if (value === undefined || value === null) {
    return { parsed: true, servers: [] };
  }

  if (Array.isArray(value)) {
    return { parsed: true, servers: value };
  }

  if (typeof value !== 'string') {
    return { parsed: false };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? { parsed: true, servers: parsed } : { parsed: false };
  } catch {
    return { parsed: false };
  }
}

function parseJsonArray(value: unknown): unknown[] {
  const result = parseManagedServerList(value);
  return result.parsed ? result.servers : [];
}

function isValidMcpServerName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

const DESKTOP_SUPPORTED_TRANSPORTS = new Set(['http', 'sse']);

/**
 * Issuer written into a structured oauth config that arrives without one.
 *
 * This is a deliberate, narrow exception to the courier rule stated throughout
 * this module (the CLI forwards backend oauth values verbatim). Without an
 * issuer, Desktop treats the config as "explicit" mode and fabricates one from
 * the *origin* of `tokenUrl`, which can never equal a Keycloak realm issuer —
 * so every flow dies with `Issuer mismatch in authorization response
 * (RFC 9207)`. Forwarding a config we know Desktop cannot complete is worse
 * than supplying the CodeMie default, and it mirrors DEFAULT_CODEMIE_BASE_URL:
 * the CLI already ships a CodeMie endpoint as its built-in default.
 *
 * A backend that publishes `authorizationServer` always wins — this only fills
 * the gap, and becomes dead weight once every deployment serves the field.
 */
const DEFAULT_AUTHORIZATION_SERVER: readonly string[] = [
  'https://auth.codemie.lab.epam.com/realms/codemie-prod',
];

/**
 * True when the value is an issuer list Desktop can actually use.
 *
 * Anything else — absent, null, a bare string, an empty array, or an array with
 * a blank entry — counts as "not provided" and takes the default. Desktop reads
 * this field as an array; a malformed value keeps it in explicit mode just as a
 * missing one does, so treating the two alike is what makes the fallback
 * effective rather than merely present.
 */
function hasUsableAuthorizationServer(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((issuer) => typeof issuer === 'string' && issuer.trim().length > 0)
  );
}

/**
 * Normalize the three accepted auth shapes into what Claude Desktop consumes.
 *
 * Precedence: a valid oauth object wins, then the oauth boolean, then the
 * legacy `auth` enum, then `false`. The final fallback preserves the behavior
 * of entries carrying neither field.
 *
 * A structured oauth config additionally gains {@link DEFAULT_AUTHORIZATION_SERVER}
 * when it carries no usable issuer. The boolean and legacy `auth` shapes are
 * left alone: they tell Desktop to discover the server's own protected-resource
 * metadata, so an injected issuer would override a working discovery path.
 */
export function resolveDesktopOAuth(entry: CanonicalMcpEntry): McpOAuthConfig | boolean {
  if (isValidOAuthConfig(entry.oauth)) {
    const oauth: McpOAuthConfig = { ...entry.oauth };
    if (!hasUsableAuthorizationServer(oauth.authorizationServer)) {
      // Fresh array per entry. Assigning the module constant itself would share
      // one mutable array across every managed entry, and cloneManagedEntry's
      // shallow oauth copy would not detach it — the same aliasing hazard that
      // function exists to prevent.
      oauth.authorizationServer = [...DEFAULT_AUTHORIZATION_SERVER];
    }
    return oauth;
  }
  if (entry.oauth === true) return true;
  if (entry.oauth === false) return false;
  if (entry.auth === 'oauth') return true;
  if (entry.auth === 'none') return false;
  return false;
}

/**
 * Map client-neutral canonical entries to Claude Desktop's managedMcpServers
 * shape. Drops entries Desktop cannot represent (non-http/sse transports,
 * missing URL, or invalid name).
 */
export function mapCanonicalToDesktop(entries: CanonicalMcpEntry[]): ManagedMcpServerEntry[] {
  const result: ManagedMcpServerEntry[] = [];
  for (const entry of entries) {
    if (!DESKTOP_SUPPORTED_TRANSPORTS.has(entry.transport)) continue;
    if (!entry.url || !isValidMcpServerName(entry.name)) continue;
    result.push({
      name: entry.name,
      url: entry.url,
      transport: entry.transport as 'http' | 'sse',
      oauth: resolveDesktopOAuth(entry),
    });
  }
  return result;
}

/**
 * The bundled defaults that are safe to seed when the org catalog fetch FAILED.
 *
 * A failed fetch must change nothing. Restoring a default whose name or URL an
 * entry already in the config occupies would make reconcileManagedMcpServers treat
 * that name as ours and drop the existing entry — silently swapping a tenant's
 * internal server for the bundled public endpoint of the same name, which is worse
 * than the revocation the null-fetch contract already forbids. Whatever the config
 * holds therefore wins; a clean or first-run config still receives the full set.
 *
 * A stored list that is present but unreadable is not an empty one: we cannot tell
 * which names and URLs it claims, so nothing is seeded at all.
 */
export function selectDefaultsForFailedFetch(
  existingServers: unknown,
  defaults: readonly ManagedMcpServerEntry[] = DEFAULT_MANAGED_MCP_SERVERS,
): ManagedMcpServerEntry[] {
  const stored = parseManagedServerList(existingServers);
  if (!stored.parsed) {
    logger.warn(
      '[proxy] Existing managed MCP list could not be parsed — seeding no bundled defaults after the failed fetch',
      ...sanitizeLogArgs({
        storedValueType: typeof existingServers,
        skippedDefaultCount: defaults.length,
      })
    );
    return [];
  }

  const existing = stored.servers.filter(isRecord);
  const takenNames = new Set(
    existing
      .map((server) => getManagedMcpServerName(server))
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase()),
  );
  const takenUrls = new Set(
    existing
      .map((server) => getManagedMcpServerUrl(server))
      .filter((url): url is string => url !== undefined),
  );
  return defaults.filter(
    (bundled) => !takenNames.has(bundled.name.toLowerCase()) && !takenUrls.has(bundled.url),
  );
}

export interface ManagedOauthShapeSummary {
  /** Entries forwarding a structured OAuth client configuration. */
  oauthConfigured: number;
  /** Entries carrying only the legacy `oauth: true` flag. */
  oauthFlagged: number;
  /** Entries with `oauth: false` or no auth information at all. */
  noAuth: number;
}

/**
 * Count the resolved oauth shapes so a silent downgrade (every entry landing on
 * `false`) or a mass validation drop is visible in the daemon log.
 *
 * Accepts loosely-typed entries so the reconciled array — managed entries plus the
 * user entries preserved beside them — can be summarized exactly as serialized.
 */
export function summarizeManagedOauthShapes(
  entries: readonly unknown[] | null,
): ManagedOauthShapeSummary {
  const summary: ManagedOauthShapeSummary = { oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 };
  for (const entry of entries ?? []) {
    const oauth = isRecord(entry) ? entry.oauth : undefined;
    if (isRecord(oauth)) summary.oauthConfigured += 1;
    else if (oauth === true) summary.oauthFlagged += 1;
    else summary.noAuth += 1;
  }
  return summary;
}

export interface ReconcileResult {
  servers: unknown[];
  managedNames: string[];
}

/**
 * Reconcile the managed MCP set into an existing managedMcpServers array.
 *
 * - `managed`: the entries CodeMie owns this run (public defaults + fetched
 *   internal), already in Desktop shape.
 * - `previouslyManagedNames`: names CodeMie wrote on the prior run. Required so
 *   that an entry removed from the managed set is dropped even though Claude
 *   Desktop re-stamps entries it persists (we cannot rely on a custom marker
 *   field surviving Desktop's rewrite).
 *
 * Genuine user-added entries (never managed by us) are preserved.
 * Managed entries appear first in the returned array; user entries follow.
 */
export function reconcileManagedMcpServers(
  existingServers: unknown,
  managed: ManagedMcpServerEntry[],
  previouslyManagedNames: string[] = [],
): ReconcileResult {
  const managedNames = managed.map((s) => s.name);
  const ownedLower = new Set(
    [...previouslyManagedNames, ...managedNames].map((n) => n.toLowerCase()),
  );
  // URL comparison is intentionally case-sensitive; managed entries come from
  // controlled sources (DEFAULT_MANAGED_MCP_SERVERS or the backend catalog) and
  // are matched verbatim.
  const managedUrls = new Set(managed.map((s) => s.url));

  // Unlike selectDefaultsForFailedFetch (which asks "which names/URLs are
  // already claimed?" and must treat unreadable as unknown-therefore-claimed),
  // this asks "which existing entries must be preserved?" An unreadable value
  // yields no identifiable entries to preserve, and a non-array value cannot be
  // written back into a field Desktop reads as an array — so [] is the
  // conservative answer to *this* question, not an inconsistency with the other.
  const filtered = parseJsonArray(existingServers).filter((server) => {
    const name = getManagedMcpServerName(server);
    const url = getManagedMcpServerUrl(server);
    if (!name) {
      // Still drop nameless entries that point at a managed URL, so a managed
      // endpoint can never be double-registered under an anonymous entry.
      return !(url && managedUrls.has(url));
    }
    if (!isValidMcpServerName(name)) return false;
    if (ownedLower.has(name.toLowerCase())) return false;
    if (url && managedUrls.has(url)) return false;
    return true;
  });

  return {
    servers: [...managed.map(cloneManagedEntry), ...filtered],
    managedNames,
  };
}
