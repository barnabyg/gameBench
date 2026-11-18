import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("compare a known decision stall, open its evidence, and replay it", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "pacing "));
  t.after(() => rm(output, { recursive: true, force: true }));
  const run = (manifest) =>
    execFileSync(process.execPath, ["src/benchmark.ts", manifest, output], {
      encoding: "utf8",
      timeout: 420000,
    }).trim();
  const first = run("examples/pacing.json");
  const report = JSON.parse(await readFile(first, "utf8"));
  assert.equal(report.inputs.seed, 2);
  assert.equal(report.inputs.scenario, "first-delivery");
  const [change] = report.pacing.changes;
  assert.deepEqual(
    [change.baseline.steps, change.candidate.steps, change.deltaSteps],
    [3, 5, 2],
  );
  assert.equal(report.pacing.stalls.baseline.length, 0);
  const [stall] = report.pacing.stalls.candidate;
  assert.equal(stall.version, "control-2");
  const log = (
    await readFile(path.join(path.dirname(first), stall.log), "utf8")
  ).split("\n");
  assert.equal(JSON.parse(log[stall.from.line - 1]).move, "dispatch");
  assert.equal(JSON.parse(log[stall.to.line - 1]).move, "confirm-delivery");
  const replay = run(path.join(path.dirname(first), report.replay));
  assert.deepEqual(
    JSON.parse(await readFile(replay, "utf8")).pacing,
    report.pacing,
  );
});
