import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  prepareSessionIdentityPublication,
  publishCommittedSessionIdentity,
} from "./session-accessor.sqlite-identity.js";
import {
  recoverRestartTombstoneInDatabase,
  type RestartTombstoneRecoveryInput,
  type RestartTombstoneRecoveryResult,
} from "./session-accessor.sqlite-recovery-kernel.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  prepareSqliteScope,
  resolveSqliteStoreScope,
  resolveSqliteWriteAdmissionScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

export type { RestartTombstoneRecoveryResult } from "./session-accessor.sqlite-recovery-kernel.js";

/** Atomically clone a tombstoned transcript and publish its linked successor. */
export async function recoverSessionEntryFromRestartTombstone(
  params: RestartTombstoneRecoveryInput & { commitGuard?: () => void; storePath: string },
): Promise<RestartTombstoneRecoveryResult> {
  const { commitGuard, storePath, ...requested } = params;
  const input = structuredClone(requested);
  const target = {
    agentId: input.agentId,
    storePath,
    sessionKey: input.sourceTarget.canonicalKey,
    env: { ...process.env },
  };
  const admission = isMainThread ? resolveSqliteWriteAdmissionScope(target) : undefined;
  const scope = captureLifecycleDatabaseScope(
    admission ??
      (isMainThread
        ? await prepareSqliteScope(target)
        : resolveSqliteStoreScope(storePath, { agentId: input.agentId })),
  );
  return await runExclusiveSqliteSessionWrite(
    scope,
    async () => {
      const resolved = admission ? await prepareSqliteScope({ ...target, env: scope.env }) : scope;
      const options = { ...toDatabaseOptions(resolved), path: resolved.path ?? scope.path };
      if (!isMainThread || !supportsOpenClawAgentDatabaseExecution(options)) {
        // Process-held incognito and maintenance databases retain their native owner.
        const diagnosticContext: {
          sourceSessionId: string;
          successorSessionId: string;
          transcriptRows?: number;
        } = {
          sourceSessionId: input.expected.sessionId,
          successorSessionId: input.successorEntry.sessionId,
        };
        const committed = runOpenClawAgentWriteTransaction(
          (database) => {
            const outcome = recoverRestartTombstoneInDatabase(
              database,
              resolved,
              input,
              () => commitGuard?.(),
              diagnosticContext,
            );
            return {
              result: outcome.result,
              publish:
                outcome.previous && outcome.current
                  ? prepareSessionIdentityPublication(
                      database,
                      resolved.agentId,
                      outcome.previous,
                      outcome.current,
                    )
                  : undefined,
            };
          },
          options,
          { operationLabel: "session.lifecycle.recover-tombstone", diagnosticContext },
        );
        committed.publish?.();
        return committed.result;
      }
      let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
      let databaseIdentity: string | undefined;
      let admitted:
        | {
            admission: SqliteWorkerOperationAdmission;
            retained: RetainedWorkerTransactionAdmission;
          }
        | undefined;
      return await withSessionEntryWorker<RestartTombstoneRecoveryResult>(
        options,
        undefined,
        () => commitGuard?.(),
        async (execution, source) => {
          const result = await execution.runExisting(source, async (worker) => {
            databaseIdentity = execution.fileIdentity?.physicalIdentity;
            if (!databaseIdentity) {
              throw new Error("Session recovery requires its admitted database identity");
            }
            publication = retainSessionEntryWorkerPublication({
              agentId: resolved.agentId,
              storePath: options.path,
              databaseIdentity,
            });
            const outcome = await worker
              .execute({
                type: "session.lifecycle.recover-tombstone",
                input: { ...input, agentId: resolved.agentId },
              })
              .then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              );
            let unknown = outcome.ok && outcome.value.status === "created" && !admitted;
            if (admitted) {
              await admitted.retained.settled;
              const facts = admitted.admission.committed?.facts;
              // The paired recovery kernel emits this existing metadata-only receipt.
              const receipt =
                isRecord(facts) && facts.kind === "session-entry-replacements"
                  ? (facts as SessionEntryReplacementPublication)
                  : undefined;
              unknown = admitted.admission.settlement?.kind !== "completed" || !receipt;
              const published = publication.settle(receipt, unknown);
              if (published) {
                publishCommittedSessionIdentity(
                  resolved.agentId,
                  databaseIdentity,
                  published.previous,
                  published.current,
                );
              }
            }
            if (unknown) {
              throw new SqliteWorkerError(
                "Session recovery has no confirmed native completion and commit receipt",
                "outcome-unknown",
              );
            }
            if (!outcome.ok) {
              throw outcome.error;
            }
            return outcome.value;
          });
          return result ?? { status: "conflict", reason: "not-tombstoned" };
        },
        (grant, retained, facts) => {
          if (isRecord(facts) && facts.publication !== undefined) {
            if (
              !isRecord(facts.publication) ||
              facts.publication.kind !== "session-entry-replacements" ||
              !Array.isArray(facts.publication.changedKeys) ||
              !facts.publication.changedKeys.every((key): key is string => typeof key === "string")
            ) {
              throw new Error("Session recovery commit omitted its publication keys");
            }
            admitted = { admission: grant, retained };
            publication?.begin(facts.publication.changedKeys, []);
          }
        },
      );
    },
    "session.restart.recover",
  );
}
