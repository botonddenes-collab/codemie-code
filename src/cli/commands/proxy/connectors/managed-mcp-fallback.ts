import { DEFAULT_MANAGED_MCP_SERVERS, type ManagedMcpServerEntry } from './managed-mcp-catalog.js';

/** What a surface seeds when the managed MCP catalog fetch returned `null`. */
export interface FailedFetchFallback {
  /** Bundled defaults to use in place of the organization catalog. */
  defaults: ManagedMcpServerEntry[];
  /** Operator-facing explanation of the fallback, or `null` when the surface shows none. */
  notice: string | null;
}

/** Surface-specific narrowing applied on top of the bundled defaults. */
export type FailedFetchSelector = (
  defaults: readonly ManagedMcpServerEntry[],
) => ManagedMcpServerEntry[];

/**
 * The single decision taken when the organization catalog fetch returns `null`:
 * fall back to the bundled defaults. Every surface (the `mcp` catalog, Claude
 * Desktop seeding) goes through here so the fallback cannot drift between them.
 *
 * A surface may narrow the defaults with `select` (Desktop drops defaults the
 * existing config already holds) and may attach its own `notice`.
 */
export function bundledOnFailedFetch(
  notice: string | null,
  select: FailedFetchSelector = (defaults) => [...defaults],
): FailedFetchFallback {
  return { defaults: select(DEFAULT_MANAGED_MCP_SERVERS), notice };
}
