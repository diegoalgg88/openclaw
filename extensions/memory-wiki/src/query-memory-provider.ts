import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-host-core";
import {
  getActiveMemoryProvider,
  type ActiveMemoryProviderResult,
  type MemoryCallerContext,
  type MemoryReference,
} from "openclaw/plugin-sdk/memory-host-search";
import type { OpenClawConfig } from "../api.js";

type SharedMemoryCaller = {
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  memoryContext?: MemoryCallerContext;
};

/** Resolves the agent whose configured memory provider owns a Wiki query. */
export function resolveActiveMemoryAgentId(params: SharedMemoryCaller): string | null {
  if (!params.appConfig) {
    return null;
  }
  if (params.agentId?.trim()) {
    return params.agentId.trim();
  }
  if (params.agentSessionKey?.trim()) {
    return resolveSessionAgentIdStrict({
      sessionKey: params.agentSessionKey,
      config: params.appConfig,
    });
  }
  return resolveDefaultAgentId(params.appConfig);
}

/** Opens one query-bound memory provider and closes it before returning. */
export async function withActiveMemoryProvider<T>(
  params: SharedMemoryCaller,
  action: (result: ActiveMemoryProviderResult) => Promise<T>,
): Promise<T> {
  const agentId = resolveActiveMemoryAgentId(params);
  let active = true;
  const caller = params.memoryContext;
  // Legacy library/CLI calls are host operations, never session-owner or operator authority.
  const context: MemoryCallerContext = {
    authority: caller?.authority ?? { kind: "host", operation: "memory-wiki.query" },
    signal: caller?.signal,
    assertCurrent() {
      if (!active) {
        throw new Error("Memory Wiki query has completed.");
      }
      caller?.assertCurrent();
      caller?.signal?.throwIfAborted();
    },
  };
  let result: ActiveMemoryProviderResult = { provider: null };
  let value: T;
  try {
    context.assertCurrent();
    if (params.appConfig && agentId) {
      result = await getActiveMemoryProvider({ cfg: params.appConfig, agentId, context });
    }
    value = await action(result);
    context.assertCurrent();
  } finally {
    active = false;
    await result.provider?.close();
  }
  // Lease cleanup can yield after selection; the caller still controls release.
  caller?.assertCurrent();
  caller?.signal?.throwIfAborted();
  return value;
}

const MEMORY_REFERENCE_PREFIX = "memory-ref:";

/** Encodes a provider-neutral memory reference as an opaque Wiki lookup token. */
export function memoryReferenceLookup(reference: MemoryReference): string {
  return `${MEMORY_REFERENCE_PREFIX}${encodeURIComponent(JSON.stringify(reference))}`;
}

/** Decodes an opaque Wiki lookup token into its validated memory reference. */
export function parseMemoryReferenceLookup(lookup: string): MemoryReference | null {
  if (!lookup.startsWith(MEMORY_REFERENCE_PREFIX)) {
    return null;
  }
  const value: unknown = JSON.parse(
    decodeURIComponent(lookup.slice(MEMORY_REFERENCE_PREFIX.length)),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid memory reference.");
  }
  // SAFETY: The guards above establish a non-null, non-array object before field validation.
  const record = value as Record<string, unknown>;
  if (
    typeof record.providerId !== "string" ||
    !record.providerId ||
    typeof record.id !== "string" ||
    !record.id ||
    (record.revision !== undefined && typeof record.revision !== "string") ||
    (record.fragment !== undefined && typeof record.fragment !== "string")
  ) {
    throw new Error("Invalid memory reference.");
  }
  return {
    providerId: record.providerId,
    id: record.id,
    ...(record.revision !== undefined ? { revision: record.revision } : {}),
    ...(record.fragment !== undefined ? { fragment: record.fragment } : {}),
  };
}
