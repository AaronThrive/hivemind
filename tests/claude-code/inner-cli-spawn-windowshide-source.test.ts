import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level guards for the inner summarizer-CLI spawns that do NOT go
 * through the wiki-worker-spawn builders (those are unit-asserted in
 * wiki-worker-windows.test.ts). Every one of these runs inside a detached,
 * console-less worker, so without `windowsHide: true` Windows pops a visible
 * console window for the claude/codex child. These call sites `spawn`/
 * `execFileSync` a real binary, so a unit test cannot observe the options
 * object — hence the scoped source guard (same approach as the hermes
 * wiki-worker and skillify gate-runner guards).
 *
 * Each regex ties `windowsHide: true` to the specific spawn/exec call
 * ([^)]* = no closing paren between the call open and the option) so the guard
 * fails if the option ever drifts out of that spawn.
 */
function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

describe("inner CLI spawn windowsHide — source guards", () => {
  it("mine-local worker spawns the summarizer claude -p with windowsHide", () => {
    expect(src("src/commands/mine-local.ts")).toMatch(/spawn\(\s*opts\.bin[^)]*windowsHide:\s*true/);
  });

  it("advisor gate spawns claude with windowsHide", () => {
    expect(src("src/skillify/advisor.ts")).toMatch(/spawn\(\s*claudeBin[^)]*windowsHide:\s*true/);
  });

  it("claude-model judge/proposer spawn passes windowsHide", () => {
    expect(src("src/skillify/claude-model.ts")).toMatch(/spawn\(\s*findAgentBin\([^;]*windowsHide:\s*true/);
  });

  it("commit-kpi-extract detached CLI spawn passes windowsHide", () => {
    expect(src("src/hooks/commit-kpi-extract.ts")).toMatch(/spawn\(\s*cli\.bin[^)]*windowsHide:\s*true/);
  });

  it("stage-memory threads windowsHide from the invocation into the spawn plan and spawn call", () => {
    const s = src("src/skillify/stage-memory.ts");
    // plan carries it through from the builder's options...
    expect(s).toMatch(/windowsHide:\s*inv\.options\.windowsHide\s*===\s*true/);
    // ...and the spawn call applies it.
    expect(s).toMatch(/spawn\(\s*plan\.file[^)]*windowsHide:\s*plan\.windowsHide/);
  });
});
