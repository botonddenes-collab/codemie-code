/**
 * Per-agent MCP registration argv tests
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import { buildAddArgs, MCP_INSTALL_AGENTS } from '../agent-registration.js';

const NAME = 'Notion';
const URL = 'https://mcp.notion.com/mcp';

describe('agent-registration', () => {
  describe('MCP_INSTALL_AGENTS', () => {
    it('lists claude, codex and gemini in that order', () => {
      expect(MCP_INSTALL_AGENTS).toEqual(['claude', 'codex', 'gemini']);
    });
  });

  describe('buildAddArgs', () => {
    describe('claude', () => {
      it('places the server name before the -- separator and the proxy command after it', () => {
        expect(buildAddArgs('claude', NAME, URL)).toEqual([
          'mcp',
          'add',
          NAME,
          '--',
          'codemie-mcp-proxy',
          URL,
        ]);
      });

      it('inserts --scope before the server name when a scope is given', () => {
        expect(buildAddArgs('claude', NAME, URL, 'user')).toEqual([
          'mcp',
          'add',
          '--scope',
          'user',
          NAME,
          '--',
          'codemie-mcp-proxy',
          URL,
        ]);
      });
    });

    describe('codex', () => {
      it('uses the name, then -- and the proxy command', () => {
        expect(buildAddArgs('codex', NAME, URL)).toEqual([
          'mcp',
          'add',
          NAME,
          '--',
          'codemie-mcp-proxy',
          URL,
        ]);
      });

      it('omits --scope because codex mcp add has no scope flag', () => {
        expect(buildAddArgs('codex', NAME, URL, 'user')).toEqual([
          'mcp',
          'add',
          NAME,
          '--',
          'codemie-mcp-proxy',
          URL,
        ]);
      });
    });

    describe('gemini', () => {
      it('passes the name and proxy command without a -- separator', () => {
        expect(buildAddArgs('gemini', NAME, URL)).toEqual([
          'mcp',
          'add',
          NAME,
          'codemie-mcp-proxy',
          URL,
        ]);
      });

      it('inserts --scope before the server name when a scope is given', () => {
        expect(buildAddArgs('gemini', NAME, URL, 'project')).toEqual([
          'mcp',
          'add',
          '--scope',
          'project',
          NAME,
          'codemie-mcp-proxy',
          URL,
        ]);
      });
    });
  });
});
