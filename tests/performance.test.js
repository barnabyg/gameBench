import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test(
  "compares controlled load times and frame spikes in the public report",
  { timeout: 90_000 },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "gamebench-performance-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    async function build(version, loadMs, frameMs) {
      const directory = path.join(root, version);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "index.html"),
        `<!doctype html>
      <script>
        // Keep the timing signals deterministic across the CI browsers.
        let frame = 0;
        const nativeFrame = requestAnimationFrame;
        window.requestAnimationFrame = (callback) => nativeFrame(() => {
          frame++;
          callback(frame * 16 + (frame >= 4 ? ${frameMs} - 16 : 0));
        });
        const mark = performance.mark.bind(performance);
        performance.mark = (name, options) => mark(name, name === "gamebench-ready"
          ? { startTime: ${loadMs} } : options);
      </script>
      <span data-testid="month">7 of 18</span>
      <section data-testid="panel-notice"><h2>Congratulations: Team lead</h2>
      <p data-testid="decided-on-paper">Official standing: Green</p></section>`,
      );
      return { version, build: directory };
    }
    const baseline = await build("baseline", 100, 16);
    const candidate = await build("candidate", 225, 88);
    const manifest = path.join(root, "comparison.json");
    await writeFile(
      manifest,
      JSON.stringify({
        adapter: path.resolve("src/failureship.ts"),
        baseline,
        candidate,
        performance: { spikeAfterMs: 50 },
        inputs: {
          scenario: "performance-review",
          strategy: "seek-team-lead",
          seed: 2,
          settings: { width: 1280, height: 800 },
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["src/benchmark.ts", manifest, root],
      {
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const reportPath = result.stdout.trim();
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const measured = report.performance;
    assert.equal(measured.unit, "ms");
    assert.equal(measured.load.interval, "navigation-to-month-header");
    assert.equal(measured.load.baseline.durationMs, 100);
    assert.equal(measured.load.candidate.durationMs, 225);
    assert.equal(measured.load.deltaMs, 125);
    assert.equal(measured.frames.interval, "first-promotion-notice");
    assert.equal(measured.frames.baseline.count, 60);
    assert.equal(measured.frames.candidate.maxMs, 88);
    assert.equal(measured.frames.deltaMaxMs, 72);
    assert.deepEqual(measured.frames.baseline.spikes, []);
    assert.deepEqual(measured.frames.candidate.spikes, [
      { frame: 3, durationMs: 88 },
    ]);
    const { log, line } = measured.frames.candidate.evidence;
    const trace = await readFile(
      path.join(path.dirname(reportPath), log),
      "utf8",
    );
    const evidence = JSON.parse(trace.split("\n")[line - 1]);
    assert.equal(evidence.event, "performance-sample");
    assert.equal(evidence.frameMs[2], 88);
  },
);
