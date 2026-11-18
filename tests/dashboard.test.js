import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { chromium } from "playwright";

test(
  "opens a saved comparison and follows its evidence in the dashboard",
  { timeout: 60_000 },
  async (context) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "gamebench-dashboard-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const benchmark = spawnSync(
      process.execPath,
      ["src/benchmark.ts", "examples/pacing.json", directory],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(benchmark.status, 0, benchmark.stderr);
    const saved = benchmark.stdout.trim();
    const regressedPath = path.join(path.dirname(saved), "regression.json");
    const comparison = JSON.parse(await readFile(saved, "utf8"));
    comparison.candidate.status = "missed";
    comparison.candidate.turns = null;
    comparison.status = "incomplete";
    delete comparison.pacing;
    await writeFile(regressedPath, JSON.stringify(comparison));
    const dashboard = spawn(
      process.execPath,
      [
        "src/dashboard.ts",
        "--port",
        "0",
        "--output",
        directory,
        "--report",
        `Review game=${saved}`,
        "--report",
        `Regression=${regressedPath}`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exit = new Promise((resolve) => dashboard.once("close", resolve));
    context.after(async () => {
      dashboard.kill();
      await exit;
    });
    const lines = createInterface({ input: dashboard.stdout });
    const first = await lines[Symbol.asyncIterator]().next();
    assert.match(first.value ?? "", /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const browser = await chromium.launch();
    context.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(first.value);
    const rows = page.getByRole("rowheader");
    await rows.first().waitFor();
    assert.deepEqual(await rows.allTextContents(), [
      "Regressionfirst-delivery",
      "Review gamefirst-delivery",
    ]);
    await page.getByRole("button", { name: "Stability: Failed" }).waitFor();
    const pacing = page.getByRole("button", { name: /Pacing.*Review/ });
    await pacing.click();
    await page
      .getByText(/5 steps/)
      .first()
      .waitFor();
    await page
      .getByText(/2 more steps/)
      .first()
      .waitFor();
    await page.getByText(/interrupt play/).waitFor();
    const log = page.getByRole("link", { name: "Candidate log" }).first();
    const response = await page.request.get(
      new URL(await log.getAttribute("href"), first.value).href,
    );
    assert.ok(response.ok());
    assert.match(await response.text(), /confirm-delivery/);
    assert.equal(
      await page.getByRole("button", { name: /Visuals.*Not measured/ }).count(),
      2,
    );
  },
);
