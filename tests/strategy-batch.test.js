import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("compare matched promotion attempts and surface a design finding without failing the batch", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "strategies "));
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(
    path.join(output, "adapter.mjs"),
    `
  import {readFileSync} from "node:fs";
  const {build,inputs}=JSON.parse(readFileSync(0,"utf8"));
  const playsMove=inputs.strategy==="politics-first" && !inputs.settings.withholdMove;
  if(playsMove)console.log(JSON.stringify({event:"decision",move:"screenshot-on-the-note",step:4}));
  const won=playsMove && (build.endsWith("candidate")||inputs.seed===2);
  console.log(JSON.stringify(won?{event:"milestone",turn:8}:{event:"milestone-missed"}));
 `,
  );
  const manifest = path.join(output, "batch.json");
  await writeFile(
    manifest,
    JSON.stringify({
      adapter: "adapter.mjs",
      baseline: { build: "baseline", version: "base" },
      candidate: { build: "candidate", version: "new" },
      seeds: [2, 16],
    }),
  );
  const reportPath = execFileSync(
    process.execPath,
    ["src/strategy-batch.ts", manifest, output],
    { encoding: "utf8", timeout: 120000 },
  ).trim();
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.status, "complete");
  assert.equal(report.cases.length, 16);
  const politics = report.comparisons.filter(
    ({ strategy }) => strategy === "politics-first",
  );
  assert.equal(politics.length, 2);
  for (const row of politics) {
    assert.deepEqual(row.baseline, {
      attempts: 2,
      promotions: 1,
      rate: 0.5,
      turns: [8],
      failed: 0,
    });
    assert.deepEqual(row.candidate, {
      attempts: 2,
      promotions: 2,
      rate: 1,
      turns: [8, 8],
      failed: 0,
    });
  }
  const finding = report.findings.find(({ role }) => role === "candidate");
  assert.equal(finding.move, "screenshot-on-the-note");
  assert.equal(finding.scenarios.length, 2);
  assert.match(finding.playtest.question, /engaging/);
  const evidence = finding.scenarios[0].evidence;
  const log = await readFile(
    path.resolve(path.dirname(reportPath), evidence.log),
    "utf8",
  );
  assert.match(log, /screenshot-on-the-note/);
});
