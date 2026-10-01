import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  recoverSessionEntryFromRestartTombstone,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import type { InternalSessionEntry } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-recovery-");

async function createFixture(extraMessages = 0) {
  const root = sessionDirs.make();
  const storePath = path.join(root, "sessions.json");
  const sourceKey = "agent:main:dashboard:tombstoned";
  const successorKey = "agent:main:dashboard:recovered";
  const sourceSessionId = "source-session";
  await replaceSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath }, {
    sessionId: sourceSessionId,
    updatedAt: 10,
    pinnedAt: 5,
    pluginOwnerId: "codex",
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 4,
      chargedAttempts: 3,
      tombstone: { reason: "automatic recovery exhausted" },
    },
  } as InternalSessionEntry);
  await replaceTranscriptEvents(
    { agentId: "main", sessionId: sourceSessionId, sessionKey: sourceKey, storePath },
    [
      {
        type: "session",
        version: 3,
        id: sourceSessionId,
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-12T00:00:01.000Z",
        message: { role: "user", content: "finish this" },
      },
      {
        type: "message",
        id: "side-branch",
        parentId: "user-1",
        timestamp: "2026-08-12T00:00:02.000Z",
        message: { role: "assistant", content: "preserve the whole transcript" },
      },
      ...Array.from({ length: extraMessages }, (_, index) => ({
        type: "message",
        id: `bulk-${index}`,
        parentId: index === 0 ? "side-branch" : `bulk-${index - 1}`,
        timestamp: "2026-08-12T00:00:02.000Z",
        message: { role: "assistant", content: "large transcript row ".repeat(200) },
      })),
      {
        type: "leaf",
        id: "leaf-1",
        parentId: "side-branch",
        timestamp: "2026-08-12T00:00:03.000Z",
        targetId: "user-1",
      },
    ],
  );
  return { root, sourceKey, sourceSessionId, storePath, successorKey };
}

describe("recoverSessionEntryFromRestartTombstone", () => {
  it("recovers a large transcript off-thread and publishes the atomic archived successor transition", async () => {
    const fixture = await createFixture(256);
    const sourceEvents = await loadTranscriptEvents({
      agentId: "main",
      sessionId: fixture.sourceSessionId,
      sessionKey: fixture.sourceKey,
      storePath: fixture.storePath,
    });
    const successorEntry = { sessionId: "successor-session", updatedAt: 20, spawnDepth: 0 };
    const params = {
      agentId: "main",
      expected: {
        cycleId: "cycle-1",
        revision: 4,
        sessionId: fixture.sourceSessionId,
        pluginOwnerId: "codex",
      },
      sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
      storePath: fixture.storePath,
      successorEntry,
      successorTarget: { canonicalKey: fixture.successorKey, storeKeys: [fixture.successorKey] },
    };

    const changes: string[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey) {
        changes.push(change.sessionKey);
      }
    });
    const sql = observeHostDataSql();
    let created: Awaited<ReturnType<typeof recoverSessionEntryFromRestartTombstone>>;
    try {
      created = await recoverSessionEntryFromRestartTombstone(params);
      expect(
        sql.queries.filter((query) =>
          /\b(?:transcript_events|transcript_payloads|session_nodes|session_windows)\b|BEGIN\s+IMMEDIATE/i.test(
            query,
          ),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
      stop();
    }
    expect(changes).toEqual(expect.arrayContaining([fixture.sourceKey, fixture.successorKey]));
    expect(created).toMatchObject({ status: "created", successorKey: fixture.successorKey });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      }),
    ).toMatchObject({
      archivedAt: expect.any(Number),
      archiveReason: "restart-recovery",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 5,
        tombstone: {
          recoveredSessionId: "successor-session",
          recoveredSessionKey: fixture.successorKey,
        },
      },
    });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      })?.pinnedAt,
    ).toBeUndefined();
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.successorKey,
        storePath: fixture.storePath,
      }),
    ).toMatchObject(successorEntry);
    const recoveredEvents = await loadTranscriptEvents({
      agentId: "main",
      sessionId: successorEntry.sessionId,
      sessionKey: fixture.successorKey,
      storePath: fixture.storePath,
    });
    expect(recoveredEvents).toHaveLength(260);
    expect(recoveredEvents[0]).toMatchObject({
      type: "session",
      id: successorEntry.sessionId,
      version: 3,
    });
    expect(recoveredEvents.slice(1)).toEqual(sourceEvents.slice(1));

    const repeated = await recoverSessionEntryFromRestartTombstone({
      ...params,
      successorEntry: { sessionId: "unused-session", updatedAt: 30 },
      successorTarget: {
        canonicalKey: "agent:main:dashboard:unused",
        storeKeys: ["agent:main:dashboard:unused"],
      },
    });
    expect(repeated).toMatchObject({
      status: "existing",
      successorKey: fixture.successorKey,
      successorEntry: { sessionId: successorEntry.sessionId },
    });
  });

  it("rolls back the transcript copy and archive when authority is revoked before worker commit", async () => {
    const fixture = await createFixture();
    let current = true;
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    using grant = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, allow) => {
          if (request.stage === "commit") {
            current = false;
          }
          return callback(request, allow);
        }, attachment),
      );
    await expect(
      recoverSessionEntryFromRestartTombstone({
        agentId: "main",
        expected: {
          cycleId: "cycle-1",
          revision: 4,
          sessionId: fixture.sourceSessionId,
          pluginOwnerId: "codex",
        },
        sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
        successorTarget: { canonicalKey: fixture.successorKey, storeKeys: [fixture.successorKey] },
        storePath: fixture.storePath,
        successorEntry: { sessionId: "revoked-successor", updatedAt: 20 },
        commitGuard: () => {
          if (!current) {
            throw new Error("Recovery authority revoked");
          }
        },
      }),
    ).rejects.toThrow("Recovery authority revoked");
    expect(current).toBe(false);
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      })?.archivedAt,
    ).toBeUndefined();
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.successorKey,
        storePath: fixture.storePath,
      }),
    ).toBeUndefined();
    expect(
      await loadTranscriptEvents({
        agentId: "main",
        sessionKey: fixture.successorKey,
        sessionId: "revoked-successor",
        storePath: fixture.storePath,
      }),
    ).toEqual([]);
  });

  it.each([
    { name: "recovery", revision: 3 },
    { name: "lifecycle", revision: 4, lifecycleRevision: "different-generation" },
  ])("does not archive or copy when the $name revision changed", async (expected) => {
    const fixture = await createFixture();
    const result = await recoverSessionEntryFromRestartTombstone({
      agentId: "main",
      expected: {
        cycleId: "cycle-1",
        revision: expected.revision,
        ...(expected.lifecycleRevision ? { lifecycleRevision: expected.lifecycleRevision } : {}),
        sessionId: fixture.sourceSessionId,
        pluginOwnerId: "codex",
      },
      sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
      storePath: fixture.storePath,
      successorEntry: { sessionId: "successor-session", updatedAt: 20 },
      successorTarget: { canonicalKey: fixture.successorKey, storeKeys: [fixture.successorKey] },
    });
    expect(result).toEqual({ status: "conflict", reason: "source-changed" });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      })?.archivedAt,
    ).toBeUndefined();
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.successorKey,
        storePath: fixture.storePath,
      }),
    ).toBeUndefined();
  });
});
