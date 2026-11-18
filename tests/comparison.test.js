import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("reject malformed evidence even when the adapter reaches its milestone", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "invalid events "));
  t.after(() => rm(output, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile("examples/comparison.json", "utf8"),
  );
  manifest.adapter = "broken.mjs";
  await writeFile(
    path.join(output, "broken.mjs"),
    `console.log('startup banner');console.log('{"event":"milestone","turn":2}');`,
  );
  const source = path.join(output, "comparison.json");
  await writeFile(source, JSON.stringify(manifest));
  const result = spawnSync(
    process.execPath,
    ["src/benchmark.ts", source, output],
    { encoding: "utf8", timeout: 420000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /baseline\.ndjson.*line 1/);
});

test("report both outcomes when the baseline exits before its checkpoint", async (t) => {
  const output = await mkdtemp(
    path.join(os.tmpdir(), "incomplete comparison "),
  );
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(
    path.join(output, "adapter.mjs"),
    `
    import {readFileSync} from "node:fs";
    const {build, inputs} = JSON.parse(readFileSync(0,"utf8"));
    console.log(JSON.stringify({event:"started", seed:inputs.seed}));
    if (build.endsWith("crashes")) {
      console.error("controlled crash");
      process.exit(12);
    }
    console.log(JSON.stringify({event:"milestone", turn:7}));
  `,
  );
  const source = path.join(output, "comparison.json");
  await writeFile(
    source,
    JSON.stringify({
      adapter: "adapter.mjs",
      baseline: { version: "crashing-build", build: "crashes" },
      candidate: { version: "healthy-build", build: "works" },
      inputs: {
        scenario: "first-promotion",
        strategy: "seek-team-lead",
        seed: 23,
        settings: {},
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    ["src/benchmark.ts", source, output],
    { encoding: "utf8", timeout: 420000 },
  );
  assert.equal(result.status, 1);
  const reportPath = result.stdout.trim();
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.inputs.seed, 23);
  assert.equal(report.status, "incomplete");
  assert.equal(report.changeInTurns, null);
  assert.deepEqual(report.outcomes, { attempted: 2, reached: 1, missing: 1 });
  assert.equal(report.baseline.version, "crashing-build");
  assert.equal(report.baseline.status, "failed");
  assert.equal(report.baseline.turns, null);
  assert.match(report.baseline.error, /controlled crash/);
  assert.equal(report.candidate.status, "reached");
  assert.equal(report.candidate.turns, 7);
  const evidence = await readFile(
    path.join(path.dirname(reportPath), report.baseline.log),
    "utf8",
  );
  assert.deepEqual(JSON.parse(evidence), { event: "started", seed: 23 });
});
