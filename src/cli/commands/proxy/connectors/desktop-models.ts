import { logger } from '@/utils/logger.js';
import { ConfigurationError } from '@/utils/errors.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { resolveTenantModelId } from './model-name-resolver.js';

export interface InferenceModelEntry {
  name: string;
}

interface ModelsListResponse {
  data?: Array<{ id?: string }>;
}

interface CodeMieLlmModel {
  id?: string;
  base_name?: string;
  deployment_name?: string;
}

/**
 * Curated list of Claude models we expose by default.
 *
 * Each entry is matched against the gateway's `/v1/models` response either as
 * an exact ID or as `<entry>-<YYYYMMDD>` (the dated variant). The actual
 * resolved ID is what gets written to the Desktop config so the gateway
 * receives a model name it has registered.
 *
 * Opus and Sonnet entries are listed in descending preference
 * (`opus: 5 → 4-8 → 4-7 → 4-6 → 3`, `sonnet: 5 → 4-6`):
 * {@link selectDesktopClaudeModels} collapses each family to the single
 * highest-priority ID the gateway actually serves, so Desktop never shows more
 * than one Opus or one Sonnet (matching the latest cloud Desktop lineup).
 */
export const PREFERRED_CLAUDE_MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

export const DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS = ['*'] as const;

/**
 * Fetch the model list from the gateway's SSO-backed `/v1/llm_models?include_all=true`
 * endpoint and return the IDs of usable Claude-family models. When both canonical
 * and `-vertex` registrations exist, canonical IDs are preferred. When only vertex
 * registrations exist, those IDs are returned so vertex-only tenants can connect.
 */
export async function fetchClaudeModels(proxyUrl: string, gatewayKey: string): Promise<string[]> {
  const endpoint = new URL('/v1/llm_models?include_all=true', proxyUrl).toString();
  try {
    logger.info(
      '[proxy] Fetching Claude models from gateway',
      ...sanitizeLogArgs({
        endpoint,
        inferenceGatewayBaseUrl: proxyUrl,
        inferenceGatewayApiKey: gatewayKey,
        preferredModels: [...PREFERRED_CLAUDE_MODELS],
      })
    );
    const response = await fetch(new URL('/v1/llm_models?include_all=true', proxyUrl), {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    if (!response.ok) {
      const isUpstreamFailure = response.status >= 500 && response.status < 600;
      logger.warn(
        '[proxy] Gateway model discovery failed',
        ...sanitizeLogArgs({
          endpoint,
          status: response.status,
          statusText: response.statusText,
          inferenceGatewayBaseUrl: proxyUrl,
          fallbackToPreferredModels: isUpstreamFailure,
        })
      );
      if (isUpstreamFailure) {
        logger.warn(
          '[proxy] Falling back to the curated Claude Desktop model list because the upstream model catalog failed',
          ...sanitizeLogArgs({
            endpoint,
            preferredModels: [...PREFERRED_CLAUDE_MODELS],
          })
        );
        return [...PREFERRED_CLAUDE_MODELS];
      }
      throw new ConfigurationError(
        response.status === 401
          ? `Local proxy model discovery was rejected with 401 Unauthorized at ${endpoint}. ` +
            'The local gateway key was not accepted by the proxy or was forwarded upstream incorrectly.'
          : `Local proxy model discovery failed at ${endpoint}: ${response.status} ${response.statusText}`
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ConfigurationError(
        `Local proxy model discovery received an unexpected response (${contentType || 'no content-type'}) from ${endpoint}. ` +
        `Your SSO session may have expired — run \`codemie proxy stop && codemie profile login\` ` +
        `to re-authenticate, then run \`codemie proxy connect desktop\` again.`
      );
    }
    const json = await response.json() as ModelsListResponse | CodeMieLlmModel[];
    const ids = Array.isArray(json)
      ? json
        .map((model) => model.id || model.base_name || model.deployment_name)
        .filter((id): id is string => typeof id === 'string')
      : (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string');
    const allClaudeIds = ids.filter((id) => /^claude-/i.test(id));
    const nonVertexClaudeIds = allClaudeIds.filter((id) => !/-vertex$/i.test(id));
    const claudeIds = nonVertexClaudeIds.length > 0 ? nonVertexClaudeIds : allClaudeIds;
    logger.info(
      '[proxy] Gateway model discovery completed',
      ...sanitizeLogArgs({
        endpoint,
        totalModelCount: ids.length,
        totalClaudeModelCount: claudeIds.length,
        availableClaudeModels: claudeIds,
        usedVertexFallback: nonVertexClaudeIds.length === 0 && allClaudeIds.length > 0,
      })
    );
    return claudeIds;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    logger.warn(
      '[proxy] Gateway model discovery threw before completion',
      ...sanitizeLogArgs({
        endpoint,
        inferenceGatewayBaseUrl: proxyUrl,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw new ConfigurationError(
      `Local proxy model discovery could not reach ${endpoint}. ` +
      `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Resolve each entry in {@link PREFERRED_CLAUDE_MODELS} against the gateway's
 * model discovery response via {@link resolveTenantModelId} — exact match, a
 * dated variant (latest if multiple), or a `-vertex` variant, in that order.
 * Entries with no available match are dropped silently.
 *
 * Preserves the order of {@link PREFERRED_CLAUDE_MODELS}.
 */
export function selectPreferredClaudeModels(
  available: string[],
  preferred: readonly string[] = PREFERRED_CLAUDE_MODELS
): string[] {
  const resolved: string[] = [];
  const missingPreferredModels: string[] = [];
  for (const name of preferred) {
    const match = resolveTenantModelId(name, available);
    if (match) {
      resolved.push(match);
    } else {
      missingPreferredModels.push(name);
    }
  }
  logger.info(
    '[proxy] Preferred Claude model selection completed',
    ...sanitizeLogArgs({
      preferredModels: [...preferred],
      availableClaudeModels: available,
      selectedModels: resolved,
      missingPreferredModels,
    })
  );
  return resolved;
}

/**
 * Build the exact model set Claude Desktop should be offered.
 *
 * Resolves the curated preferred list via {@link selectPreferredClaudeModels},
 * then collapses the opus and sonnet families to a single entry each: the first
 * (highest-priority) ID that resolved. With preferred order
 * `opus: 5 → 4-8 → 4-7 → 4-6 → 3` and `sonnet: 5 → 4-6` in
 * {@link PREFERRED_CLAUDE_MODELS}, this exposes Opus 5 / Sonnet 5 when the
 * gateway serves them and otherwise falls back to the next-best available ID
 * in each family. Haiku and any other non-opus/non-sonnet models are passed
 * through untouched; order is preserved.
 */
export function selectDesktopClaudeModels(
  available: string[],
  preferred: readonly string[] = PREFERRED_CLAUDE_MODELS
): string[] {
  const resolved = selectPreferredClaudeModels(available, preferred);
  let opusKept = false;
  let sonnetKept = false;
  return resolved.filter((id) => {
    if (/^claude-opus-/i.test(id)) {
      if (opusKept) return false;
      opusKept = true;
      return true;
    }
    if (/^claude-sonnet-/i.test(id)) {
      if (sonnetKept) return false;
      sonnetKept = true;
      return true;
    }
    return true;
  });
}
