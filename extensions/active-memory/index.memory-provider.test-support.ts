import { expect, it, vi, type Mock } from "vitest";

type MemoryProviderTestParams = {
  getActiveMemoryProvider: Mock;
  runEmbeddedAgent: Mock;
  registerPluginConfig: (overrides: Record<string, unknown>) => void;
  runPromptBuild: (
    event: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Registers provider-neutral Active Memory trigger admission coverage. */
export function registerActiveMemoryProviderTests(params: MemoryProviderTestParams): void {
  it.each([" \n "])(
    "does not recall historical text for an explicit empty request %j",
    async (currentUserMessage) => {
      params.registerPluginConfig({ mode: "always" });
      const search = vi.fn(async () => ({ hits: [] }));
      params.getActiveMemoryProvider.mockResolvedValue({
        provider: {
          search,
          capabilities: { candidates: ["trigger"] },
          candidates: vi.fn(async () => ({ hits: [] })),
          close: vi.fn(),
        },
      });
      await params.runPromptBuild({
        prompt: "What do you remember about my preferences?",
        currentUserMessage,
        currentUserMessageId: "empty-admission",
        messages: [{ role: "user", content: "What do you remember about my preferences?" }],
      });
      expect(search).not.toHaveBeenCalled();
      expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
    },
  );

  it("reuses one trigger admission across history changes and keeps authority separate", async () => {
    params.registerPluginConfig({ mode: "escalate" });
    const search = vi.fn(async () => ({ hits: [] }));
    params.getActiveMemoryProvider.mockResolvedValue({
      provider: {
        search,
        capabilities: { candidates: ["trigger"] },
        candidates: vi.fn(async () => ({ hits: [] })),
        close: vi.fn(),
      },
    });
    for (const [history, fingerprint, admission] of [
      ["old history", "authority-a", "same-admission"],
      ["rebuilt history", "authority-a", "same-admission"],
      ["rebuilt history", "authority-b", "same-admission"],
      ["rebuilt history", "authority-b", "new-admission"],
    ] as const) {
      await params.runPromptBuild(
        {
          prompt: history,
          currentUserMessage: "ok",
          currentUserMessageId: admission,
          messages: [{ role: "user", content: history }],
        },
        {
          runId: "trigger-rebuild",
          toolAuthority: {
            fingerprint,
            allows: () => true,
            assertActive: () => undefined,
          },
        },
      );
    }
    expect(search).toHaveBeenCalledTimes(3);
    expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
  });
}
