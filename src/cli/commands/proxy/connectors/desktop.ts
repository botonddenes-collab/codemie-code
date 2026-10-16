import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getClaudeDesktopBaseDir,
  getClaudeDesktopManagedSettingsPath,
} from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import {
  DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS,
  fetchClaudeModels,
  selectDesktopClaudeModels,
  type InferenceModelEntry,
} from './desktop-models.js';
import {
  reconcileManagedMcpServers,
  selectDefaultsForFailedFetch,
  summarizeManagedOauthShapes,
} from './managed-mcp-reconcile.js';
import {
  DEFAULT_MANAGED_MCP_SERVERS,
  mergeManagedMcpServers,
  type ManagedMcpServerEntry,
} from './managed-mcp-catalog.js';
import { bundledOnFailedFetch } from './managed-mcp-fallback.js';

export * from './desktop-models.js';
export * from './managed-mcp-reconcile.js';
export {
  DEFAULT_MANAGED_MCP_SERVERS,
  cloneManagedEntry,
  mergeManagedMcpServers,
} from './managed-mcp-catalog.js';
export type {
  ManagedMcpMergeResult,
  ManagedMcpServerEntry,
  ManagedOauthDowngrade,
} from './managed-mcp-catalog.js';

const INFERENCE_KEYS = [
  'inferenceProvider',
  'inferenceGatewayBaseUrl',
  'inferenceGatewayApiKey',
  'inferenceGatewayAuthScheme',
] as const;

interface ManagedMcpState {
  managedNames: string[];
}

/** Default location of the CLI-owned managed-MCP marker state. */
export function getManagedMcpStatePath(): string {
  return getCodemiePath('proxy', 'desktop-managed-mcp-state.json');
}

async function readManagedMcpState(statePath: string): Promise<string[]> {
  if (!existsSync(statePath)) return [];
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf-8')) as ManagedMcpState;
    return Array.isArray(parsed.managedNames)
      ? parsed.managedNames.filter((n): n is string => typeof n === 'string')
      : [];
  } catch {
    return [];
  }
}

async function writeManagedMcpState(statePath: string, managedNames: string[]): Promise<void> {
  const dir = join(statePath, '..');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  // Atomic write (tmp + rename), mirroring daemon-manager.writeState. A crash
  // mid-write must never leave a truncated marker: readManagedMcpState would
  // parse-fail and fall back to [], silently orphaning every previously-managed
  // entry (it would no longer match by name and be preserved as a user entry).
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify({ managedNames }, null, 2), 'utf-8');
  await rename(tmp, statePath);
}

export interface DesktopGatewayConfig {
  inferenceProvider: 'gateway';
  inferenceGatewayBaseUrl: string;
  inferenceGatewayApiKey: string;
  inferenceGatewayAuthScheme: 'bearer';
}

interface ConfigMetaEntry {
  id: string;
  name: string;
}

interface ConfigMeta {
  appliedId?: string;
  entries?: ConfigMetaEntry[];
}

export function buildGatewayConfig(proxyUrl: string, gatewayKey: string): DesktopGatewayConfig {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: proxyUrl,
    inferenceGatewayApiKey: gatewayKey,
    inferenceGatewayAuthScheme: 'bearer',
  };
}

/**
 * Returns the base directory where Claude Desktop (3P) stores its config.
 * macOS:   ~/Library/Application Support/Claude-3p
 * Windows: %LOCALAPPDATA%\Claude-3p
 * Linux:   $XDG_CONFIG_HOME/Claude-3p, else ~/.config/Claude-3p
 */
export function getDesktopBaseDir(): string {
  return getClaudeDesktopBaseDir();
}

/**
 * Explains why a local config write may not take effect, or null when nothing
 * is in the way. Claude Desktop applies a managed (MDM) source in preference to
 * the local config library, ignoring local values entirely.
 *
 * The path is injectable so callers and tests can supply one; by default it is
 * resolved from the platform.
 */
export function describeManagedSettingsOverride(
  managedSettingsPath: string | null = getClaudeDesktopManagedSettingsPath()
): string | null {
  if (!managedSettingsPath || !existsSync(managedSettingsPath)) return null;
  return (
    `${managedSettingsPath} exists. Claude Desktop applies managed settings ` +
    `instead of local configuration, so this write may have no effect.`
  );
}

/**
 * Returns the path to the active inference config JSON file under configLibrary/.
 * If `_meta.json` doesn't exist or has no `appliedId`, returns the path that
 * a freshly-generated UUID would use; the caller is responsible for creating
 * `_meta.json` to register it.
 */
export async function getDesktopConfigPath(baseDir: string = getDesktopBaseDir()): Promise<string> {
  const libDir = join(baseDir, 'configLibrary');
  const metaPath = join(libDir, '_meta.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as ConfigMeta;
      if (meta.appliedId) return join(libDir, `${meta.appliedId}.json`);
    } catch {
      // Corrupt meta — fall through to fresh UUID
    }
  }
  return join(libDir, `${randomUUID()}.json`);
}

/**
 * Write/merge the CodeMie gateway settings into Claude Desktop's
 * `configLibrary/<UUID>.json` and update `_meta.json` so the app picks them up.
 *
 * Preserves unrelated keys in the existing config file.
 * Returns the absolute path of the config file written.
 */
export async function writeDesktopConfig(
  proxyUrl: string,
  gatewayKey: string,
  baseDir: string = getDesktopBaseDir(),
  orgMcpServers: ManagedMcpServerEntry[] | null = null,
  managedStatePath: string = getManagedMcpStatePath()
): Promise<string> {
  const libDir = join(baseDir, 'configLibrary');
  if (!existsSync(libDir)) {
    await mkdir(libDir, { recursive: true });
  }

  const metaPath = join(libDir, '_meta.json');
  let meta: ConfigMeta = {};
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf-8')) as ConfigMeta;
    } catch {
      meta = {};
    }
  }

  const configId = meta.appliedId ?? randomUUID();
  const configPath = join(libDir, `${configId}.json`);

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }

  // Discover available Claude models from the gateway and curate down to the
  // preferred set (a single opus, preferring 4.8) so the user doesn't have to
  // type them manually in the GUI.
  const discoveredModels = await fetchClaudeModels(proxyUrl, gatewayKey);
  if (discoveredModels.length === 0) {
    throw new ConfigurationError(
      `Local proxy did not expose any Claude models from ${new URL('/v1/llm_models?include_all=true', proxyUrl).toString()}.`
    );
  }
  const resolvedModels = selectDesktopClaudeModels(discoveredModels);
  if (resolvedModels.length === 0) {
    throw new ConfigurationError(
      'Local proxy discovered Claude models, but none matched the preferred CodeMie desktop set.'
    );
  }
  const inferenceModels: InferenceModelEntry[] = resolvedModels.map((name) => ({ name }));
  // `orgMcpServers === null` means the catalog fetch FAILED (or was skipped for a
  // missing CodeMie URL) — distinct from a successful fetch that returned []. On
  // failure we must NOT revoke previously-managed org entries (a transient backend
  // outage would otherwise strip the user's internal MCPs) and must leave the
  // marker state untouched so a later successful run can still revoke.
  const orgFetchSucceeded = orgMcpServers !== null;

  // Dedup bundled public defaults against the org catalog so an entry the
  // backend also publishes is written once (see mergeManagedMcpServers for the
  // collision precedence). On a FAILED fetch the defaults are first narrowed to
  // those the config does not already hold, so a previously-written org entry
  // that shadowed a default is never evicted by the public endpoint it replaced.
  const org = orgMcpServers ?? [];
  const seedDefaults = orgFetchSucceeded
    ? DEFAULT_MANAGED_MCP_SERVERS
    : bundledOnFailedFetch(null, (defaults) =>
        selectDefaultsForFailedFetch(existing.managedMcpServers, defaults),
      ).defaults;
  const { managed: managedSet, oauthDowngrades, displacedDefaults } = mergeManagedMcpServers(seedDefaults, org);
  if (oauthDowngrades.length > 0) {
    logger.warn(
      '[proxy] Managed MCP entry published without the auth its bundled default declares (auth downgrade) — forwarding it as published',
      ...sanitizeLogArgs({
        oauthDowngradeCount: oauthDowngrades.length,
        sourceBundledDefaults: oauthDowngrades.map((downgrade) => downgrade.defaultName),
        downgradedBackendEntries: oauthDowngrades.map((downgrade) => downgrade.backendName),
        downgradedUrls: oauthDowngrades.map((downgrade) => downgrade.url),
      })
    );
  }
  const previouslyManagedNames = orgFetchSucceeded ? await readManagedMcpState(managedStatePath) : [];
  const { servers: managedMcpServers, managedNames } = reconcileManagedMcpServers(
    existing.managedMcpServers,
    managedSet,
    previouslyManagedNames,
  );

  // Marker write-ahead (successful fetch only): record the UNION of previously-
  // and newly-managed names BEFORE writing the config. If we crash between this
  // write and the config write, the next run still sees every name we might have
  // left in the config and can revoke it — so neither an add nor a revoke can
  // orphan an entry. The marker is narrowed to the exact managed set AFTER the
  // config is durable (see below), which releases revoked names so a user can
  // later reclaim them. On a failed fetch we leave the prior marker untouched so
  // a later successful run can still revoke.
  if (orgFetchSucceeded) {
    const unionNames = [...new Set([...previouslyManagedNames, ...managedNames])];
    await writeManagedMcpState(managedStatePath, unionNames);
  }

  // Summarize the reconciled list we are about to serialize (not the org catalog
  // index.ts already logs), so the shape counts always add up to
  // managedMcpServerCount and a logged auth downgrade is visible in the field.
  // seededDefaultCount reports what was offered to the merge, not what was
  // written — displacedDefaultCount and displacedDefaults reconcile the difference.
  const writtenOauthShapes = summarizeManagedOauthShapes(managedMcpServers);
  logger.info(
    '[proxy] Preparing Claude Desktop config payload',
    ...sanitizeLogArgs({
      baseDir,
      configPath,
      inferenceGatewayBaseUrl: proxyUrl,
      inferenceGatewayApiKey: gatewayKey,
      discoveredModelCount: discoveredModels.length,
      discoveredModels,
      resolvedModelCount: resolvedModels.length,
      resolvedModels,
      inferenceModelsWritten: inferenceModels.length > 0,
      managedMcpServerCount: managedMcpServers.length,
      seededDefaultCount: seedDefaults.length,
      displacedDefaultCount: displacedDefaults.length,
      displacedDefaults,
      oauthDowngradeCount: oauthDowngrades.length,
      oauthConfiguredCount: writtenOauthShapes.oauthConfigured,
      oauthFlaggedCount: writtenOauthShapes.oauthFlagged,
      noAuthCount: writtenOauthShapes.noAuth,
      existingConfigKeys: Object.keys(existing),
    })
  );

  for (const key of INFERENCE_KEYS) {
    delete existing[key];
  }
  delete existing.inferenceModels;
  delete existing.coworkEgressAllowedHosts;
  delete existing.managedMcpServers;

  const merged = {
    ...existing,
    ...buildGatewayConfig(proxyUrl, gatewayKey),
    ...(inferenceModels.length > 0 ? { inferenceModels: JSON.stringify(inferenceModels) } : {}),
    coworkEgressAllowedHosts: JSON.stringify([...DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS]),
    managedMcpServers: JSON.stringify(managedMcpServers),
  };
  await writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  logger.info(
    '[proxy] Claude Desktop config file updated',
    ...sanitizeLogArgs({
      configPath,
      inferenceGatewayBaseUrl: proxyUrl,
      inferenceGatewayApiKey: gatewayKey,
      inferenceModelsWritten: inferenceModels.length > 0,
      resolvedModels,
      managedMcpServerCount: managedMcpServers.length,
      finalConfigKeys: Object.keys(merged),
    })
  );

  // Narrow the marker to exactly what we just wrote, now that the config is
  // durable (see the write-ahead union above). This releases names dropped from
  // the managed set so they no longer count as owned on the next run.
  if (orgFetchSucceeded) {
    await writeManagedMcpState(managedStatePath, managedNames);
  }

  const entries = meta.entries ?? [];
  if (!entries.find((e) => e.id === configId)) {
    entries.push({ id: configId, name: 'CodeMie Proxy' });
  }
  const updatedMeta: ConfigMeta = {
    appliedId: configId,
    entries,
  };
  await writeFile(metaPath, JSON.stringify(updatedMeta, null, 2), 'utf-8');

  return configPath;
}
