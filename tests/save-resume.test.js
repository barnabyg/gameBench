import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test(
  "reports whether each build resumes the same save and can continue",
  { timeout: 90_000 },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "gamebench-save-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    async function build(name, restoresSave) {
      const directory = path.join(root, name);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "index.html"),
        `<!doctype html>
      <span data-testid="month">7 of 18</span>
      <button data-testid="open-inbox">2 to answer</button>
      <main></main>
      <script>
        const inbox = document.querySelector("button");
        const panel = document.querySelector("main");
        function showResult() {
          inbox.textContent = "1 to answer";
          panel.innerHTML = '<section data-testid="panel-result"><p data-testid="answer-result">Report filed</p><button data-testid="continue">Continue</button></section>';
          panel.querySelector("button").onclick = () => {
            panel.innerHTML = '<button data-testid="inbox-item">Next message</button>';
          };
        }
        inbox.onclick = () => {
          panel.innerHTML = '<button data-testid="inbox-item" data-to-answer="true">Message</button>';
          panel.querySelector("button").onclick = () => {
            panel.innerHTML = '<section data-testid="panel-notification"><button data-testid="option-report">Report</button></section>';
            panel.querySelector("button").onclick = () => {
              localStorage.setItem("run", "answered");
              showResult();
            };
          };
        };
        if (localStorage.getItem("run")) {
          if (${restoresSave}) showResult();
          else panel.innerHTML = '<p data-testid="save-lost">Save lost</p>';
        }
      </script>`,
      );
      return { build: directory, version: name };
    }
    const baseline = await build("restores", true);
    const candidate = await build("loses-save", false);
    const manifest = path.join(root, "comparison.json");
    await writeFile(
      manifest,
      JSON.stringify({
        adapter: path.resolve("src/failureship.ts"),
        baseline,
        candidate,
        saveResume: true,
        inputs: {
          scenario: "save-resume",
          strategy: "answer-and-resume",
          seed: 2,
          settings: { width: 1280, height: 800 },
        },
      }),
    );
    function run(source) {
      const result = spawnSync(
        process.execPath,
        ["src/benchmark.ts", source, root],
        {
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stdout.trim(), result.stderr);
      return result.stdout.trim();
    }
    const reportPath = run(manifest);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const { saveResume } = report;
    assert.equal(saveResume.baseline.status, "passed");
    assert.equal(saveResume.baseline.before.remaining, "1 to answer");
    assert.deepEqual(saveResume.baseline.after, saveResume.baseline.before);
    assert.equal(saveResume.baseline.step, "continue");
    assert.equal(saveResume.candidate.version, "loses-save");
    assert.equal(saveResume.candidate.status, "failed");
    assert.equal(saveResume.candidate.step, "reload");
    const directory = path.dirname(reportPath);
    const log = await readFile(
      path.join(directory, saveResume.candidate.log),
      "utf8",
    );
    const evidence = JSON.parse(log.split("\n")[saveResume.candidate.line - 1]);
    assert.equal(evidence.event, "save-resume");
    assert.equal(evidence.status, "failed");
    const screenshot = await readFile(
      path.join(directory, saveResume.candidate.screenshot),
    );
    assert.equal(screenshot.toString("ascii", 1, 4), "PNG");
    const replay = run(path.join(directory, report.replay));
    const replayed = JSON.parse(await readFile(replay, "utf8"));
    assert.equal(replayed.saveResume.candidate.step, "reload");
  },
);
