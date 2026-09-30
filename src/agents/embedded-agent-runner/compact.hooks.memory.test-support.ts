import { vi, type Mock } from "vitest";

type MockMemorySearchManager = {
  manager: {
    sync: (params?: unknown) => Promise<void>;
  };
};

export const getMemorySearchManagerMock: Mock<
  (params?: unknown) => Promise<MockMemorySearchManager>
> = vi.fn(async () => ({ manager: { sync: vi.fn(async () => {}) } }));

export const getMemoryProviderMock = vi.fn();

export const resolveMemoryBackendConfigMock = vi.fn<
  () => { backend: "builtin" } | { backend: "provider-runtime"; providerId: string }
>(() => ({ backend: "builtin" }));

export const resolveMemorySearchConfigMock = vi.fn(() => ({
  sources: ["sessions"],
  sync: { sessions: { postCompactionForce: true } },
}));

/** Restores the memory runtime mocks shared by compact hook tests. */
export function resetCompactMemoryMocks(): void {
  getMemorySearchManagerMock.mockReset();
  getMemorySearchManagerMock.mockResolvedValue({
    manager: { sync: vi.fn(async () => {}) },
  });
  getMemoryProviderMock.mockReset();
  resolveMemoryBackendConfigMock.mockReset().mockReturnValue({ backend: "builtin" });
  resolveMemorySearchConfigMock.mockReset().mockReturnValue({
    sources: ["sessions"],
    sync: { sessions: { postCompactionForce: true } },
  });
}
