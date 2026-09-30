import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  assertMemoryAudienceSession,
  isHostMemoryAudience,
  resolveMemoryAudienceFromEntry,
} from "../../../plugins/memory-audience.js";
import type { MemoryAudience } from "../../../plugins/memory-provider-types.js";
import { log } from "../logger.js";

const retainedAudience = () => {};

/**
 * Keep a delegated audience bound to this attempt, or resolve its admitted
 * source row. The returned release ends the attempt-owned session leases.
 */
export async function resolveEmbeddedAttemptMemoryAudience(params: {
  memoryAudience?: MemoryAudience;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  senderIsOwner: boolean | undefined;
  admission?: { entry: SessionEntry; storePath: string };
  assertCallerCurrent?: () => void;
}): Promise<{ memoryAudience?: MemoryAudience; release: () => void }> {
  if (params.memoryAudience) {
    if (!isHostMemoryAudience(params.memoryAudience)) {
      throw new Error("Embedded run memory audience must be host-minted.");
    }
    // The delegating owner keeps custody of a supplied audience's leases.
    assertMemoryAudienceSession(params.memoryAudience, params.sessionKey);
    return { memoryAudience: params.memoryAudience, release: retainedAudience };
  }
  if (!params.admission) {
    return { release: retainedAudience };
  }
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      senderIsOwner: params.senderIsOwner,
      storePath: params.admission.storePath,
      assertCallerCurrent: params.assertCallerCurrent,
    },
    params.admission.entry,
  );
  if (resolution.status === "granted") {
    return { memoryAudience: resolution.audience, release: resolution.release };
  }
  // A denial grants no private or conversation memory; legacy rows need an
  // operator-visible reason because respawning is the only repair.
  if (resolution.legacyLineage) {
    log.warn(`memory audience unavailable: ${resolution.reason}`);
  } else {
    log.debug(`memory audience unavailable: ${resolution.reason}`);
  }
  return { release: retainedAudience };
}
