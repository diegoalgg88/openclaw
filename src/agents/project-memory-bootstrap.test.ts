import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySearchHit } from "../plugins/memory-provider-types.js";
import {
  buildProjectMemoryWriteInstruction,
  filterProjectScopedCuratedContextFiles,
  prepareProjectMemoryBootstrap,
} from "./project-memory-bootstrap.js";

const runtimeMocks = vi.hoisted(() => ({
  getManager: vi.fn(),
  listCurated: vi.fn(),
  search: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({ debug: vi.fn() }));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemoryProviderCore: (...args: unknown[]) => runtimeMocks.getManager(...args),
}));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logMocks }));

describe("project memory bootstrap", () => {
  beforeEach(() => {
    runtimeMocks.getManager.mockReset();
    runtimeMocks.listCurated.mockReset();
    runtimeMocks.search.mockReset();
    logMocks.debug.mockReset();
  });

  const entries: MemorySearchHit[] = [
    {
      reference: { providerId: "records", id: "release" },
      excerpt: "Use the release helper.",
      score: 0.8,
      automaticRecall: {
        eligible: true,
        projectKeys: ["github.com/OpenClaw/OpenClaw"],
        importance: 8,
      },
    },
    {
      reference: { providerId: "records", id: "foreign" },
      excerpt: "Foreign fact.",
      score: 0.9,
      automaticRecall: {
        eligible: true,
        projectKeys: ["github.com/example/other"],
        importance: 10,
      },
    },
  ];
  async function prepareEntries(
    candidates: MemorySearchHit[],
    activeProjectKeys = ["github.com/OpenClaw/OpenClaw"],
  ): Promise<string[]> {
    runtimeMocks.listCurated.mockResolvedValue({ hits: candidates });
    runtimeMocks.getManager.mockResolvedValue({
      provider: {
        capabilities: { candidates: ["project"] },
        candidates: runtimeMocks.listCurated,
        close: vi.fn(),
      },
    });
    return prepareProjectMemoryBootstrap({ cfg: {}, agentId: "main", activeProjectKeys });
  }

  it("includes only active-project entries and stays inside its budget", async () => {
    const lines = await prepareEntries([
      ...entries,
      {
        ...entries[0]!,
        excerpt: "Untrusted project instruction.",
        automaticRecall: { eligible: false, projectKeys: ["github.com/OpenClaw/OpenClaw"] },
      },
      {
        ...entries[0]!,
        excerpt: "Missing-provenance project instruction.",
        automaticRecall: undefined,
      },
    ]);
    const rendered = lines.join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(rendered).not.toContain("Foreign fact");
    expect(rendered).not.toContain("Untrusted project instruction");
    expect(rendered).not.toContain("Missing-provenance project instruction");
    expect(rendered).not.toContain("<!--");
    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });

  it("includes entries from every project retained in the session active set", async () => {
    const rendered = (
      await prepareEntries(entries, ["github.com/example/other", "github.com/OpenClaw/OpenClaw"])
    ).join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(rendered).toContain("Foreign fact.");
  });

  it("never emits a partial entry or exceeds the hard budget", async () => {
    const crowded = Array.from({ length: 10 }, (_, index) => ({
      ...entries[0]!,
      reference: { providerId: "records", id: String(index + 1) },
      excerpt: `${String(index)} ${"bounded entry ".repeat(50)}`,
    }));
    const lines = await prepareEntries(crowded);
    expect(lines.join("\n").length).toBeLessThanOrEqual(2_000);
    expect(lines.slice(2, -1).every((line) => /\(Source: records:\d+\)$/u.test(line))).toBe(true);
  });

  it("truncates long entries before admission while preserving the hard cap", async () => {
    const rendered = (await prepareEntries([{ ...entries[0]!, excerpt: "🧠".repeat(1_000) }])).join(
      "\n",
    );
    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });

  it("admits a later exact-fit entry after skipping an oversized entry", async () => {
    const first = Array.from({ length: 3 }, (_, index) => ({
      ...entries[0]!,
      reference: { providerId: "records", id: String(index + 1) },
      excerpt: "a".repeat(550),
    }));
    const prefix = await prepareEntries(first);
    const sourceSuffix = " (Source: records:5)";
    const remaining = 2_000 - prefix.join("\n").length;
    const lastSnippet = "z".repeat(remaining - "- ".length - sourceSuffix.length - 1);
    const lines = await prepareEntries([
      ...first,
      { ...entries[0]!, reference: { providerId: "records", id: "4" }, excerpt: "b".repeat(600) },
      { ...entries[0]!, reference: { providerId: "records", id: "5" }, excerpt: lastSnippet },
      { ...entries[0]!, reference: { providerId: "records", id: "6" }, excerpt: "Does not fit." },
    ]);

    expect(lines).toEqual([...prefix.slice(0, -1), `- ${lastSnippet}${sourceSuffix}`, ""]);
    expect(lines.join("\n")).toHaveLength(2_000);
  });

  it("keeps sessions without an active repository unchanged", async () => {
    await expect(prepareEntries(entries, [])).resolves.toEqual([]);
    expect(runtimeMocks.getManager).not.toHaveBeenCalled();
    expect(buildProjectMemoryWriteInstruction(undefined)).toBe("");
  });

  it("filters tagged raw entries fail-closed with the all-keys rule", () => {
    const contextFiles = [
      {
        path: "MEMORY.md",
        content: [
          "- Global fact.",
          "- Alpha fact. <!-- project: github.com/acme/Alpha -->",
          "- Shared fact. <!-- project: github.com/acme/Alpha; github.com/acme/Beta -->",
          "- Invalid fact. <!-- project: github.com/acme/Beta< -->",
          "- Mixed invalid fact. <!-- project: github.com/acme/Alpha; bad< -->",
          "- Unterminated fact. <!-- project: github.com/acme/Alpha",
        ].join("\n"),
      },
    ];
    const empty = filterProjectScopedCuratedContextFiles({ contextFiles });
    const alpha = filterProjectScopedCuratedContextFiles({
      contextFiles,
      activeProjectKeys: ["github.com/acme/Alpha"],
    });
    const both = filterProjectScopedCuratedContextFiles({
      contextFiles,
      activeProjectKeys: ["github.com/acme/Alpha", "github.com/acme/Beta"],
    });

    expect(empty[0]?.content).toBe("- Global fact.");
    expect(alpha[0]?.content).toContain("Alpha fact");
    expect(alpha[0]?.content).not.toContain("Shared fact");
    expect(alpha[0]?.content).not.toContain("Invalid fact");
    expect(alpha[0]?.content).not.toContain("Mixed invalid fact");
    expect(alpha[0]?.content).not.toContain("Unterminated fact");
    expect(both[0]?.content).toContain("Shared fact");
    expect(both[0]?.content).not.toContain("Invalid fact");
    expect(both[0]?.content).not.toContain("Mixed invalid fact");
    expect(both[0]?.content).not.toContain("Unterminated fact");
  });

  it("leaves context files with missing or blank paths for the prompt renderer to ignore", () => {
    const contextFiles = [
      { path: undefined as unknown as string, content: "Missing path" },
      { path: "   ", content: "Blank path" },
    ];

    expect(filterProjectScopedCuratedContextFiles({ contextFiles })).toEqual(contextFiles);
  });

  it("uses the dedicated curated listing instead of a daily-note-crowded search", async () => {
    runtimeMocks.search.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        ...entries[0]!,
        path: `memory/2026-07-${String(index + 1).padStart(2, "0")}.md`,
      })),
    );
    runtimeMocks.listCurated.mockResolvedValue({ hits: [entries[0]] });
    runtimeMocks.getManager.mockResolvedValue({
      provider: {
        capabilities: { candidates: ["project"] },
        search: runtimeMocks.search,
        candidates: runtimeMocks.listCurated,
        close: vi.fn(),
      },
    });

    const rendered = (
      await prepareProjectMemoryBootstrap({
        cfg: {},
        agentId: "main",
        activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
      })
    ).join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(runtimeMocks.search).not.toHaveBeenCalled();
    expect(runtimeMocks.listCurated).toHaveBeenCalledWith({
      kind: "project",
      activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
      limit: 48,
    });
  });

  it("skips undeclared project capability and releases its lease", async () => {
    const close = vi.fn();
    runtimeMocks.getManager.mockResolvedValue({
      provider: {
        capabilities: { candidates: ["trigger"] },
        candidates: runtimeMocks.listCurated,
        close,
      },
    });
    expect(
      await prepareProjectMemoryBootstrap({
        cfg: {},
        agentId: "main",
        activeProjectKeys: ["alpha"],
      }),
    ).toEqual([]);
    expect(runtimeMocks.listCurated).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("omits optional project recall when provider cleanup rejects", async () => {
    const close = vi.fn().mockRejectedValue(new Error("provider cleanup failed"));
    runtimeMocks.getManager.mockResolvedValue({
      provider: {
        capabilities: { candidates: ["project"] },
        candidates: runtimeMocks.listCurated,
        close,
      },
    });
    runtimeMocks.listCurated.mockResolvedValue({ hits: entries });

    await expect(
      prepareProjectMemoryBootstrap({
        cfg: {},
        agentId: "main",
        activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
      }),
    ).resolves.toEqual([]);
    expect(runtimeMocks.listCurated).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(logMocks.debug).toHaveBeenCalledWith(
      expect.stringContaining("project memory cleanup failed: Error: provider cleanup failed"),
    );
  });

  it.each(["selection", "close"])(
    "does not inject records after caller authority is revoked during %s",
    async (during) => {
      let active = true;
      const close = vi.fn(async () => {
        if (during === "close") {
          active = false;
        }
      });
      runtimeMocks.getManager.mockResolvedValue({
        provider: {
          capabilities: { candidates: ["project"] },
          candidates: runtimeMocks.listCurated,
          close,
        },
      });
      runtimeMocks.listCurated.mockImplementation(async () => {
        if (during === "selection") {
          active = false;
        }
        return { hits: entries };
      });
      expect(
        await prepareProjectMemoryBootstrap({
          cfg: {},
          agentId: "main",
          activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
          context: {
            authority: { kind: "host", operation: "project-test" },
            assertCurrent() {
              if (!active) {
                throw new Error("revoked");
              }
            },
          },
        }),
      ).toEqual([]);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("builds scoped write guidance without capturing global memory", () => {
    const instruction = buildProjectMemoryWriteInstruction("github.com/OpenClaw/OpenClaw");
    expect(instruction).toContain("<!-- project: github.com/OpenClaw/OpenClaw -->");
    expect(instruction).toContain("Do not project-scope user-level preferences");
    expect(buildProjectMemoryWriteInstruction("path:/tmp/unsafe-->note")).toBe("");
  });
});
