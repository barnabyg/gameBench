import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { command } from "../src/dashboard-command.ts";

test(
  "compares controlled load times and frame spikes in the public report",
  { timeout: 450_000 },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "gamebench-performance-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    async function build(version, loadDelayMs, frameStallMs) {
      const directory = path.join(root, version);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "index.html"),
        `<!doctype html>
      <main></main><script>
        // Delay a real render and block a real frame without replacing browser timestamps.
        let frame = 0;
        const nativeFrame = requestAnimationFrame;
        window.requestAnimationFrame = (callback) => nativeFrame((timestamp) => {
          if (++frame === 4) {
            const until = performance.now() + ${frameStallMs};
            while (performance.now() < until) {}
          }
          callback(timestamp);
        });
        setTimeout(() => {
          document.querySelector("main").innerHTML = '<span data-testid="month">7 of 18</span><section data-testid="panel-notice"><h2>Congratulations: Team lead</h2><p data-testid="decided-on-paper">Official standing: Green</p></section>';
        }, ${loadDelayMs});
      </script>`,
      );
      return { version, build: directory };
    }
    const baseline = await build("baseline", 0, 0);
    const candidate = await build("candidate", 600, 350);
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
    const result = await command(
      process.execPath,
      ["src/benchmark.ts", manifest, root],
      {
        timeout: 390_000,
      },
    );
    assert.equal(result.status, 0, result.error ?? result.stderr);
    const reportPath = result.stdout.trim();
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const measured = report.performance;
    assert.equal(measured.unit, "ms");
    assert.equal(measured.load.interval, "navigation-to-month-header");
    assert.ok(measured.load.candidate.durationMs >= 600);
    assert.ok(measured.load.deltaMs >= 300, JSON.stringify(measured.load));
    assert.equal(measured.frames.interval, "first-promotion-notice");
    assert.equal(measured.frames.baseline.count, 60);
    assert.equal(measured.frames.candidate.count, 60);
    assert.ok(
      measured.frames.deltaMaxMs >= 200,
      JSON.stringify(measured.frames),
    );
    const spike = measured.frames.candidate.spikes.find(
      ({ durationMs }) => durationMs >= 300,
    );
    assert.ok(spike, JSON.stringify(measured.frames.candidate));
    const { log, line } = measured.frames.candidate.evidence;
    const trace = await readFile(
      path.join(path.dirname(reportPath), log),
      "utf8",
    );
    const evidence = JSON.parse(trace.split("\n")[line - 1]);
    assert.equal(evidence.event, "performance-sample");
    assert.equal(
      Number(evidence.frameMs[spike.frame - 1].toFixed(3)),
      spike.durationMs,
    );
  },
);
