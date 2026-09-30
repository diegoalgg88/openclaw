// Fast context runtime tests cover timeout and fast context generation behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveMemoryProviderCore: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemoryProviderCore: mocks.getActiveMemoryProviderCore,
}));

import { resolveRealtimeVoiceFastContextConsult } from "./fast-context-runtime.js";

const liveness = { assertCurrent() {} };

describe("resolveRealtimeVoiceFastContextConsult", () => {
  beforeEach(() => {
    mocks.getActiveMemoryProviderCore.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caps oversized fast-context timeouts before scheduling Node timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mocks.getActiveMemoryProviderCore.mockResolvedValue({
      provider: {
        close: vi.fn(),
        search: vi.fn().mockResolvedValue({ hits: [] }),
      },
    });

    await expect(
      resolveRealtimeVoiceFastContextConsult({
        cfg: {},
        agentId: "main",
        sessionKey: "voice:15550001234",
        config: {
          enabled: true,
          timeoutMs: Number.MAX_SAFE_INTEGER,
          maxResults: 3,
          sources: ["memory", "sessions"],
          fallbackToConsult: true,
        },
        args: { question: "What do you remember?" },
        logger: {},
        liveness,
      }),
    ).resolves.toEqual({ handled: false });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("preserves the fast-context timeout error and clears the timer", async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn() };
    mocks.getActiveMemoryProviderCore.mockResolvedValue({
      provider: {
        close: vi.fn(),
        search: vi.fn(() => new Promise<never>(() => {})),
      },
    });

    const result = resolveRealtimeVoiceFastContextConsult({
      cfg: {},
      agentId: "main",
      sessionKey: "voice:15550001234",
      config: {
        enabled: true,
        timeoutMs: 25,
        maxResults: 3,
        sources: ["memory", "sessions"],
        fallbackToConsult: true,
      },
      args: { question: "What do you remember?" },
      logger,
      liveness,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual({ handled: false });
    expect(logger.debug).toHaveBeenCalledWith(
      "[talk] fast context lookup failed: fast context lookup timed out after 25ms",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not split a surrogate pair at the fast-context snippet limit", async () => {
    const safePrefix = "x".repeat(698);
    mocks.getActiveMemoryProviderCore.mockResolvedValue({
      provider: {
        close: vi.fn(),
        search: vi.fn().mockResolvedValue({
          hits: [
            {
              reference: { providerId: "records", id: "test" },
              excerpt: `${safePrefix}🚀tail`,
              source: "memory",
              score: 1,
            },
          ],
        }),
      },
    });

    const result = await resolveRealtimeVoiceFastContextConsult({
      cfg: {},
      agentId: "main",
      sessionKey: "voice:15550001234",
      config: {
        enabled: true,
        timeoutMs: 1_000,
        maxResults: 1,
        sources: ["memory"],
        fallbackToConsult: true,
      },
      args: { question: "What do you remember?" },
      logger: {},
      liveness,
    });

    expect(result).toEqual({
      handled: true,
      result: {
        text: expect.stringContaining(`1. [memory] records:test\n${safePrefix}...`),
      },
    });
  });

  it("passes genuine request identity without inventing owner privileges and revokes after return", async () => {
    const search = vi.fn().mockResolvedValue({
      hits: [{ reference: { providerId: "records", id: "visible" }, excerpt: "Visible memory" }],
    });
    const close = vi.fn();
    mocks.getActiveMemoryProviderCore.mockResolvedValue({ provider: { search, close } });
    const result = await resolveRealtimeVoiceFastContextConsult({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:voice:caller",
      config: {
        enabled: true,
        timeoutMs: 1000,
        maxResults: 2,
        sources: ["memory", "sessions"],
        fallbackToConsult: false,
      },
      args: { question: "What do you remember?" },
      logger: {},
      liveness,
    });
    const { context } = mocks.getActiveMemoryProviderCore.mock.calls[0]![0];
    expect(context.authority).toEqual({
      kind: "session",
      sessionKey: "agent:main:voice:caller",
      sandboxed: false,
    });
    expect(() => context.assertCurrent()).toThrow("request has ended");
    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      handled: true,
      result: { text: expect.stringContaining("Visible memory") },
    });
  });

  it.each(["search", "close"])(
    "does not publish hits after caller authority expires during %s",
    async (during) => {
      let active = true;
      const close = vi.fn(async () => {
        if (during === "close") {
          active = false;
        }
      });
      mocks.getActiveMemoryProviderCore.mockResolvedValue({
        provider: {
          close,
          search: vi.fn(async () => {
            if (during === "search") {
              active = false;
            }
            return {
              hits: [{ reference: { providerId: "records", id: "secret" }, excerpt: "Secret" }],
            };
          }),
        },
      });
      const result = await resolveRealtimeVoiceFastContextConsult({
        cfg: {},
        agentId: "main",
        sessionKey: "voice:caller",
        config: {
          enabled: true,
          timeoutMs: 1000,
          maxResults: 2,
          sources: ["memory"],
          fallbackToConsult: true,
        },
        args: { question: "What do you remember?" },
        logger: {},
        liveness: {
          assertCurrent() {
            if (!active) {
              throw new Error("revoked");
            }
          },
        },
      });
      expect(result).toEqual({ handled: false });
      expect(close).toHaveBeenCalledOnce();
    },
  );
});
