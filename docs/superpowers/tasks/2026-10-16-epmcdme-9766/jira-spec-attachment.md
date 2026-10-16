# Jira attachment `spec.md` (EPMCDME-9766) — REFERENCE ONLY, PRE-RESCOPE

> This is the original pre-rescope attachment, supplied by the user on 2026-10-16. It describes a
> backend (Python/FastAPI) change and is superseded by the ticket's 2026-09-25 rescope, which keeps
> the work entirely in codemie-code and sources the catalog from `/v1/mcp/managed-servers` + the
> bundled fallback. Use it only as background (intent: list curated MCPs, install by name,
> local-only install into an agent's config). The attachment `plan.md` is outdated and was discarded.

---

# EPMCDME-9766: Predefined & Whitelisted MCP Catalog for codemie-code CLI

## Context

The `codemie-code` CLI (external npm package `@codemieai/code`) needs a way to browse and
install curated MCP servers without users sourcing configs from the internet.

The backend already has a DB-backed MCP catalog (`mcp_configs` table, ~15 pre-seeded system
entries) exposed via `GET /v1/mcp-configs`. Two small gaps prevent the CLI from using it:

1. No `is_system` filter — CLI cannot isolate whitelisted entries from user-created ones.
2. No exact-name lookup — `mcp install jira` needs to resolve "jira" to a config reliably.

"Install" is **local-only**: the CLI fetches the config and writes it to the agent's config
file (e.g. `~/.claude/settings.json`). No server-side installation tracking is needed.

---

## API Changes

### 1. Add `is_system` filter to `GET /v1/mcp-configs`

```
GET /v1/mcp-configs?is_system=true&active_only=true
```

- New optional param `is_system: bool | None` (default `None` = no filter, preserves existing behaviour).
- Applied as `WHERE is_system = <value>` when provided.
- CLI uses `?is_system=true` to get only curated/whitelisted entries.

### 2. New endpoint: `GET /v1/mcp-configs/by-name/{name}`

- Case-insensitive exact match on the `name` field (`lower(name) = lower(:name)`).
- Filters to `is_active = true` only.
- Returns a single `MCPConfigResponse` on success.
- Returns `404 Not Found` with `{"detail": "MCP config '{name}' not found"}` when no match.
- If multiple rows share the same name (system + user-created), the system config wins
  (secondary sort `is_system DESC, usage_count DESC`).
- Available to all authenticated users (same auth as `GET /v1/mcp-configs/{id}`).
- Must be registered before `GET /v1/mcp-configs/{config_id}` in the router.

---

## CLI Flow

```
codemie-code mcp list
  → GET /v1/mcp-configs?is_system=true&active_only=true
  → displays name, description, categories

codemie-code mcp install jira --agent=claude
  → GET /v1/mcp-configs/by-name/jira
  → receives MCPConfigResponse (config.command, config.args, required_env_vars)
  → CLI writes config to ~/.claude/settings.json (local, no further backend call)
```

---

## Service Layer

- `MCPConfigService.list_configs()` gains `is_system: bool | None = None`.
- New `MCPConfigService.get_by_name(name: str)`: `WHERE lower(name) = lower(:name) AND is_active
  ORDER BY is_system DESC, usage_count DESC LIMIT 1`; 404 via `ExtendedHTTPException` when absent.

## Error Handling

| Scenario | Response |
|---|---|
| Name not found | `404 {"detail": "MCP config '{name}' not found"}` |
| Unauthenticated request | `401` (existing middleware) |
| DB error | `500` (existing middleware) |

## Test Cases

| Test | Assertion |
|---|---|
| `?is_system=true` | Returns only rows with `is_system=True` |
| `?is_system=false` | Returns only rows with `is_system=False` |
| no param | Returns all rows |
| `by-name/jira` | Case-insensitive match |
| `by-name/JIRA` | Same config |
| `by-name/unknown` | `404` |
| System + user share name | System config wins |

## Out of Scope (original)

- Server-side install tracking (install is local-only).
- Changes to `GET /v1/mcp/managed-servers`.
- CLI source code (external repository).
- New MCP catalog entries.
