import { stripMemoryAnnotationCarriers } from "../../packages/memory-host-sdk/src/host/curated-annotations.js";
import {
  isAutomaticMemoryEntryEligible,
  type MemorySearchResult,
} from "../memory-host-sdk/host/types.js";
import type {
  MemoryCallerContext,
  MemoryProviderHandle,
  MemoryProviderOpenParams,
  MemoryProviderOpenResult,
  MemorySearchHit,
  MemorySearchPage,
  MemoryCitation,
  MemoryReference,
} from "./memory-provider-types.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";

/** Recheck both caller and provider lifetime after every asynchronous boundary. */
export function bindMemoryProvider(
  provider: MemoryProviderHandle,
  providerId: string,
  context: MemoryCallerContext,
  runtimeOwner?: object,
): MemoryProviderHandle {
  let closed = false;
  const instance =
    getPluginValueInstance(provider) ??
    (runtimeOwner ? getPluginValueInstance(runtimeOwner) : undefined);
  const assertCurrent = () => {
    if (closed) {
      throw new Error("memory provider handle is closed");
    }
    context.assertCurrent();
    context.signal?.throwIfAborted();
    if (
      instance &&
      (!instance.acceptingCalls || instance.owner?.revoked || instance.lifecycle.signal.aborted)
    ) {
      throw new Error("memory provider instance is no longer current");
    }
  };
  const invoke = async <T>(run: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const result = await run();
    assertCurrent();
    return result;
  };
  const assertReference = (reference: MemoryReference) => {
    if (reference.providerId !== providerId) {
      throw new Error("memory reference belongs to a different provider");
    }
  };
  const assertCitations = (citations?: MemoryCitation[]) => {
    for (const citation of citations ?? []) {
      if (citation.reference) {
        assertReference(citation.reference);
      }
    }
  };
  const validatePage = (page: MemorySearchPage) => {
    for (const hit of page.hits) {
      assertReference(hit.reference);
      assertCitations(hit.citations);
    }
    return page;
  };
  const capabilities = Object.freeze({
    ...provider.capabilities,
    sources: Object.freeze([...provider.capabilities.sources]),
    candidates: Object.freeze([...provider.capabilities.candidates]),
  });
  const assertSearchCapabilities = (request: Parameters<MemoryProviderHandle["search"]>[0]) => {
    const unsupportedSource = request.sources?.find(
      (source) => !capabilities.sources.includes(source),
    );
    if (unsupportedSource) {
      throw new Error(
        `memory provider does not support the ${unsupportedSource} source capability`,
      );
    }
    if (request.cursor !== undefined && !capabilities.pagination) {
      throw new Error("memory provider does not support the pagination capability");
    }
    if (request.activeProjectKeys?.length && !capabilities.projectFilter) {
      throw new Error("memory provider does not support the project filter capability");
    }
  };
  return {
    capabilities,
    search: (request) =>
      invoke(async () => {
        assertSearchCapabilities(request);
        return validatePage(await provider.search(request));
      }),
    get: (request) =>
      invoke(async () => {
        assertReference(request.reference);
        const result = await provider.get(request);
        if (result.status === "ok") {
          assertReference(result.reference);
          assertCitations(result.citations);
        }
        return result;
      }),
    health: () => invoke(() => provider.health()),
    ...(provider.candidates
      ? {
          candidates: (request: Parameters<NonNullable<MemoryProviderHandle["candidates"]>>[0]) => {
            return invoke(async () => {
              if (!capabilities.candidates.includes(request.kind)) {
                throw new Error(
                  `memory provider does not support the ${request.kind} candidates capability`,
                );
              }
              if (request.activeProjectKeys?.length && !capabilities.projectFilter) {
                throw new Error("memory provider does not support the project filter capability");
              }
              return validatePage(await provider.candidates!(request));
            });
          },
        }
      : {}),
    ...(provider.refresh ? { refresh: () => invoke(() => provider.refresh!()) } : {}),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      // Lease release is teardown and must remain possible after caller revocation.
      await runPluginCleanup(provider, () => provider.close());
    },
  };
}

/** Translate the legacy contract without mutating managers or changing their receiver. */
export async function adaptLegacyMemoryProvider(
  runtime: MemoryPluginRuntime,
  providerId: string,
  params: MemoryProviderOpenParams,
): Promise<MemoryProviderOpenResult> {
  const result = await runtime.getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
  });
  const manager = result.manager;
  if (!manager) {
    return { provider: null, error: result.error };
  }
  const { context } = params;
  const session = context.authority.kind === "session" ? context.authority : undefined;
  const assertCurrent = () => {
    context.assertCurrent();
    context.signal?.throwIfAborted();
  };
  const authorize = async (hits: MemorySearchResult[]) => {
    assertCurrent();
    const authorized = runtime.authorizeSearchHits
      ? await runtime.authorizeSearchHits({
          cfg: params.cfg,
          agentId: params.agentId,
          requesterSessionKey: session?.sessionKey,
          // Host and operator callers act for the opened agent without a session, as
          // `memory.search` v1 and Memory Wiki did; session callers keep requester visibility
          // plus any recall pass their host granted.
          sandboxed: session?.sandboxed ?? false,
          trustedAgentScope: !session,
          conversationRecall: session?.conversationRecall,
          hits,
        })
      : hits.filter((hit) => hit.source !== "sessions");
    assertCurrent();
    return authorized;
  };
  const convert = (hit: MemorySearchResult): MemorySearchHit => {
    const reference = { providerId, id: hit.path, fragment: `L${hit.startLine}-L${hit.endLine}` };
    return {
      reference,
      excerpt: stripMemoryAnnotationCarriers(hit.snippet),
      score: hit.score,
      source: hit.source,
      citations: [
        {
          label: hit.citation ?? `${hit.path}#L${hit.startLine}-L${hit.endLine}`,
          reference,
          startLine: hit.startLine,
          endLine: hit.endLine,
        },
      ],
      automaticRecall: {
        eligible: hit.source === "memory" && isAutomaticMemoryEntryEligible(hit),
        projectKeys: hit.projectKey
          ?.split(";")
          .map((key) => key.trim())
          .filter(Boolean),
        triggers: hit.triggers,
        importance: hit.importance,
      },
    };
  };
  const candidates = [
    ...(manager.listTriggerCandidates ? ["trigger" as const] : []),
    ...(manager.listCuratedProjectCandidates ? ["project" as const] : []),
  ];
  const provider: MemoryProviderHandle = {
    capabilities: {
      sources: ["memory", "sessions"],
      pagination: false,
      candidates,
      projectFilter: true,
    },
    async search(request) {
      if (request.cursor !== undefined) {
        throw new Error("legacy memory search does not support cursors");
      }
      if (typeof manager.search !== "function") {
        throw new Error("memory runtime manager must implement search");
      }
      const { query, cursor: _cursor, activeProjectKeys, ...options } = request;
      const hits = await manager.search(query, {
        ...options,
        activeProjectKeys: activeProjectKeys ? [...activeProjectKeys] : undefined,
        sessionKey: session?.sessionKey,
        signal: context.signal,
      });
      return { hits: (await authorize(hits)).map(convert), coverage: "complete" };
    },
    async get(request) {
      // readFile is the legacy provider's read authorization boundary, including
      // virtual paths. Search visibility cannot grant a read or replace that policy.
      if (typeof manager.readFile !== "function") {
        throw new Error("memory runtime manager must implement readFile");
      }
      const read = await manager.readFile({
        relPath: request.reference.id,
        from: request.from,
        lines: request.lines,
      });
      if (read.status === "not_found") {
        return { status: "not_found" };
      }
      return {
        status: "ok",
        reference: { providerId, id: read.path },
        text: read.text,
        truncated: read.truncated,
        from: read.from,
        lines: read.lines,
        nextFrom: read.nextFrom,
      };
    },
    async health() {
      const status = manager.status();
      return {
        status: status.lastSyncError ? "degraded" : "ready",
        message: status.lastSyncError,
        details: { legacy: status },
      };
    },
    ...(manager.listTriggerCandidates || manager.listCuratedProjectCandidates
      ? ({
          async candidates(request) {
            const activeProjectKeys = request.activeProjectKeys
              ? [...request.activeProjectKeys]
              : [];
            let hits: MemorySearchResult[];
            if (request.kind === "project") {
              if (!manager.listCuratedProjectCandidates) {
                throw new Error("memory provider does not support project candidates");
              }
              hits = (
                await manager.listCuratedProjectCandidates({
                  activeProjectKeys,
                  limit: request.limit,
                })
              ).filter(
                (hit) =>
                  hit.path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase() === "memory.md",
              );
            } else {
              if (!manager.listTriggerCandidates) {
                throw new Error("memory provider does not support trigger candidates");
              }
              hits = await manager.listTriggerCandidates({
                activeProjectKeys,
                limit: request.limit,
              });
            }
            return { hits: (await authorize(hits)).map(convert), coverage: "complete" as const };
          },
        } satisfies Pick<MemoryProviderHandle, "candidates">)
      : {}),
    ...(manager.sync ? { refresh: () => manager.sync!({ reason: "provider-refresh" }) } : {}),
    async close() {
      if (params.purpose === "cli" || params.purpose === "status") {
        await runPluginCleanup(manager, () => manager.close?.());
      }
    },
  };
  return { provider };
}
