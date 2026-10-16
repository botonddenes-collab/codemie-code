import { describe, it, expect, vi } from 'vitest';
import { bundledOnFailedFetch } from '@/cli/commands/proxy/connectors/managed-mcp-fallback.js';
import { DEFAULT_MANAGED_MCP_SERVERS } from '@/cli/commands/proxy/connectors/managed-mcp-catalog.js';

describe('bundledOnFailedFetch', () => {
  it('falls back to every bundled default and carries the notice through', () => {
    const fallback = bundledOnFailedFetch('org catalog unavailable');

    expect(fallback.defaults).toEqual(DEFAULT_MANAGED_MCP_SERVERS);
    expect(fallback.notice).toBe('org catalog unavailable');
  });

  it('reports no notice when the surface has none to show', () => {
    expect(bundledOnFailedFetch(null).notice).toBeNull();
  });

  it('layers a surface-specific selector over the bundled defaults', () => {
    const select = vi.fn((defaults: readonly (typeof DEFAULT_MANAGED_MCP_SERVERS)[number][]) =>
      defaults.slice(0, 1),
    );

    const fallback = bundledOnFailedFetch(null, select);

    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(DEFAULT_MANAGED_MCP_SERVERS);
    expect(fallback.defaults).toEqual(DEFAULT_MANAGED_MCP_SERVERS.slice(0, 1));
  });

  it('returns a fresh array so callers cannot mutate the bundled constant', () => {
    const fallback = bundledOnFailedFetch(null);

    expect(fallback.defaults).not.toBe(DEFAULT_MANAGED_MCP_SERVERS);
  });
});
