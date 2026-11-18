import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
    const dashboard = spawn(
      process.execPath,
      [
        "src/dashboard.ts",
        "--port",
        "0",
        "--report",
        `Failureship=${benchmark.stdout.trim()}`,
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
    await page.getByRole("rowheader", { name: "Failureship" }).waitFor();
    const pacing = page.getByRole("button", { name: /Pacing.*Review/ });
    await pacing.click();
    await page
      .getByText(/5 steps/)
      .first()
      .waitFor();
    const log = page.getByRole("link", { name: "Candidate log" });
    const response = await page.request.get(
      new URL(await log.getAttribute("href"), first.value).href,
    );
    assert.ok(response.ok());
    assert.match(await response.text(), /confirm-delivery/);
    await page.getByRole("button", { name: /Visuals.*Not measured/ }).waitFor();
  },
);
