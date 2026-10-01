import { vi, type Mock } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;

export type SessionManagerMocks = {
  getSessionTarget: Mock<() => undefined>;
  getSessionId: Mock<() => string>;
  getAppendParentId: Mock<() => string | null>;
  getHeader: UnknownMock;
  getLeafId: Mock<() => string | null>;
  getLeafEntry: UnknownMock;
  getEntry: UnknownMock;
  getEntries: UnknownMock;
  getBranch: UnknownMock;
  getBoundaryCount: UnknownMock;
  branch: UnknownMock;
  resetLeaf: UnknownMock;
  buildSessionContext: Mock<() => { messages: AgentMessage[] }>;
  appendThinkingLevelChange: UnknownMock;
  appendModelChange: UnknownMock;
  appendCustomEntry: UnknownMock;
  appendCustomEntryAsync: (...args: unknown[]) => Promise<unknown>;
  appendMessage: UnknownMock;
  appendMessageAsync: (...args: unknown[]) => Promise<unknown>;
  appendSessionInfo: UnknownMock;
  appendLabelChange: UnknownMock;
  flushPendingPersistence: UnknownMock;
  flushPendingToolResults: UnknownMock;
  clearPendingToolResults: UnknownMock;
  reloadPersistedTranscript: UnknownMock;
  clearNextUserMessagePersistenceSuppression: UnknownMock;
  removeTrailingEntries: UnknownMock;
};

export function createSessionManagerMocks(): SessionManagerMocks {
  const sessionManager = {
    getSessionTarget: vi.fn(() => undefined),
    getSessionId: vi.fn(() => "embedded-session"),
    getAppendParentId: vi.fn<() => string | null>(() => null),
    getHeader: vi.fn(() => ({ version: 3 })),
    getLeafId: vi.fn<() => string | null>(() => null),
    getLeafEntry: vi.fn(() => null),
    getEntry: vi.fn(() => undefined),
    getEntries: vi.fn(() => []),
    getBranch: vi.fn(() => []),
    getBoundaryCount: vi.fn(() => 0),
    branch: vi.fn(),
    resetLeaf: vi.fn(),
    buildSessionContext: vi.fn<() => { messages: AgentMessage[] }>(() => ({ messages: [] })),
    appendThinkingLevelChange: vi.fn(),
    appendModelChange: vi.fn(),
    appendCustomEntry: vi.fn(),
    appendCustomEntryAsync: async (...args: unknown[]): Promise<unknown> =>
      sessionManager.appendCustomEntry(...args),
    appendMessage: vi.fn(),
    appendMessageAsync: async (...args: unknown[]): Promise<unknown> =>
      sessionManager.appendMessage(...args),
    appendSessionInfo: vi.fn(),
    appendLabelChange: vi.fn(),
    flushPendingPersistence: vi.fn(),
    flushPendingToolResults: vi.fn(),
    clearPendingToolResults: vi.fn(),
    reloadPersistedTranscript: vi.fn(),
    clearNextUserMessagePersistenceSuppression: vi.fn(),
    removeTrailingEntries: vi.fn(() => 0),
  };
  return sessionManager;
}
