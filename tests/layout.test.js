import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("pass clean promotion layouts and gate repeatable clipping and overlap with screenshots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "promotion layout "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = async (name, css) => {
    const directory = path.join(root, name);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "index.html"),
      `<!doctype html><title>Promotion fixture</title><style>
     body{font:16px Arial} section{position:relative;margin:20px;width:450px}
     ${css}</style><span data-testid="month">7 of 18</span>
     <section data-testid="panel-notice"><h2>Congratulations: Team lead</h2>
     <p data-testid="decided-on-paper">Official standing: Green</p>
     <p data-testid="decided-in-fact">The seat was in the gift of the boss</p>
     <button data-testid="continue">Continue</button></section>`,
    );
    return directory;
  };
  const clean = await fixture("clean", "");
  const defects = await fixture(
    "defects",
    `
   [data-testid=decided-on-paper]{width:60px;white-space:nowrap;overflow:hidden}
   [data-testid=decided-in-fact]{margin:0}
   button{position:absolute;left:10px;bottom:0}
 `,
  );
  const adapter = path.resolve("src/failureship.ts");
  for (const candidate of [clean, defects]) {
    const manifest = path.join(root, "comparison.json");
    await writeFile(
      manifest,
      JSON.stringify({
        adapter,
        baseline: { build: clean, version: "clean" },
        candidate: { build: candidate, version: path.basename(candidate) },
        inputs: {
          scenario: "first-promotion",
          strategy: "seek-team-lead",
          seed: 2,
          settings: { width: 1280, height: 800, checkLayout: true },
        },
      }),
    );
    const command = spawnSync(
      process.execPath,
      ["src/benchmark.ts", manifest, root],
      { encoding: "utf8", timeout: 420000 },
    );
    const reportPath = command.stdout.trim();
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(command.status, candidate === clean ? 0 : 1, command.stderr);
    assert.equal(
      report.layout.status,
      candidate === clean ? "passed" : "failed",
    );
    assert.deepEqual(report.layout.resolution, { width: 1280, height: 800 });
    assert.deepEqual(report.layout.baseline.issues, []);
    const issues = report.layout.candidate.issues;
    if (candidate === defects) {
      assert.equal(report.layout.candidate.version, "defects");
      assert.ok(
        issues.some(
          (issue) =>
            issue.type === "clipping" && issue.target === "decided-on-paper",
        ),
      );
      assert.ok(
        issues.some(
          (issue) =>
            issue.type === "overlap" &&
            [issue.target, issue.other].includes("continue"),
        ),
      );
    } else assert.deepEqual(issues, []);
    for (const role of ["baseline", "candidate"]) {
      const png = await readFile(
        path.join(path.dirname(reportPath), report[role].screenshot),
      );
      assert.deepEqual(
        [png.readUInt32BE(16), png.readUInt32BE(20)],
        [1280, 800],
      );
    }
  }
});
