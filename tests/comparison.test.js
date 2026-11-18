import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("compare a known pair and replay the same seeded playthrough from its evidence", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "paired runs "));
  t.after(() => rm(output, { recursive: true, force: true }));
  function run(manifest) {
    return execFileSync(
      process.execPath,
      ["src/benchmark.ts", manifest, output],
      { encoding: "utf8", timeout: 420000 },
    ).trim();
  }
  const reportPath = run("examples/comparison.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(
    [report.baseline.turns, report.candidate.turns, report.changeInTurns],
    [4, 6, 2],
  );
  assert.deepEqual(
    [report.baseline.version, report.candidate.version],
    ["control-1", "control-2"],
  );
  const evidence = (file, source = reportPath) =>
    readFile(path.resolve(path.dirname(source), file), "utf8");
  const manifest = JSON.parse(await evidence(report.replay));
  assert.deepEqual(manifest.inputs, {
    scenario: "first-delivery",
    strategy: "deliver",
    seed: 2,
    settings: { pace: 1 },
  });
  const baseline = await evidence(report.baseline.log);
  const candidate = await evidence(report.candidate.log);
  assert.match(baseline, /first-delivery/);
  assert.match(candidate, /"turn":6/);
  const replayPath = run(path.resolve(path.dirname(reportPath), report.replay));
  assert.notEqual(replayPath, reportPath);
  const replay = JSON.parse(await readFile(replayPath, "utf8"));
  assert.equal(replay.changeInTurns, 2);
  assert.equal(await evidence(replay.baseline.log, replayPath), baseline);
  assert.equal(await evidence(replay.candidate.log, replayPath), candidate);
});
