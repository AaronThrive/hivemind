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

  // The helper LOOKUPS, not the CLI spawns. These run `where.exe` on Windows
  // on the way to launching a detached worker, so without CREATE_NO_WINDOW
  // each one allocates its own visible window — the same flash the CLI spawns
  // produced, one layer earlier. (resolveCliBin is also called from inside
  // already-detached workers, which have no console to inherit at all.)
  it("resolveCliBin's where/which lookup passes windowsHide", () => {
    expect(src("src/utils/resolve-cli-bin.ts")).toMatch(
      /execFileSync\(isWin \? "where" : "which"[^)]*windowsHide:\s*true/,
    );
  });

  it("the mine-local worker's hivemind lookup passes windowsHide", () => {
    expect(src("src/skillify/spawn-mine-local-worker.ts")).toMatch(
      /execFileSync\(lookup[^)]*windowsHide:\s*true/,
    );
  });

  it("stage-memory threads windowsHide from the invocation into the spawn plan and spawn call", () => {
    const s = src("src/skillify/stage-memory.ts");
    // plan carries it through from the builder's options...
    expect(s).toMatch(/windowsHide:\s*inv\.options\.windowsHide\s*===\s*true/);
    // ...and the spawn call applies it.
    expect(s).toMatch(/spawn\(\s*plan\.file[^)]*windowsHide:\s*plan\.windowsHide/);
  });
});

/**
 * The detached WORKER launches themselves. `detached: true` maps to
 * DETACHED_PROCESS, which makes Windows ignore CREATE_NO_WINDOW — but libuv
 * sets SW_HIDE from `windowsHide` as well, and that still applies, so the
 * option is not a no-op on these. `spawn-detached.ts` has always paired the
 * two; these are the launches that were missing it.
 */
describe("detached worker spawn windowsHide — source guards", () => {
  it("mine-local worker launch passes windowsHide", () => {
    expect(src("src/skillify/spawn-mine-local-worker.ts")).toMatch(/spawn\(cmd,\s*args[^)]*windowsHide:\s*true/);
  });

  it("backfill-memory worker launch passes windowsHide", () => {
    expect(src("src/skillify/spawn-backfill-memory-worker.ts")).toMatch(/spawn\(cmd,\s*cmdArgs[^)]*windowsHide:\s*true/);
  });

  it("the auto-spawned embedding daemon passes windowsHide", () => {
    expect(src("src/embeddings/client.ts")).toMatch(/spawn\(process\.execPath,\s*\[this\.daemonEntry\][^)]*windowsHide:\s*true/);
  });

  it("pi's auto-mine launcher lookup and worker launch both pass windowsHide", () => {
    const pi = src("harnesses/pi/extension-source/hivemind.ts");
    expect(pi).toMatch(/execFileSync\("which",\s*\["hivemind"\][^)]*windowsHide:\s*true/);
    expect(pi).toMatch(/spawn\(cmd,\s*args[^)]*windowsHide:\s*true/);
  });

  it("openclaw's agent lookup and skillify worker launch both pass windowsHide", () => {
    const oc = src("harnesses/openclaw/src/index.ts");
    expect(oc).toMatch(/realExecFileSync\("which",\s*\[bin\][^)]*windowsHide:\s*true/);
    expect(oc).toMatch(/realSpawn\(process\.execPath,\s*\[OPENCLAW_SKILLIFY_WORKER_PATH[^)]*windowsHide:\s*true/);
  });
});
