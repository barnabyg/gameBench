import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { z } from "zod";

const { build, inputs, screenshot, failureScreenshot } = z
  .object({
    build: z.string(),
    inputs: z.object({
      scenario: z.literal("first-harvest"),
      strategy: z.literal("store-surplus"),
      seed: z.literal(29),
    }),
    screenshot: z.string(),
    failureScreenshot: z.string(),
  })
  .parse(JSON.parse(readFileSync(0, "utf8")));

function emit(event: object) {
  console.log(JSON.stringify(event));
}

async function completeFirstYear(page: Page, origin: string) {
  const response = await page.goto(origin, { timeout: 30000 });
  if (!response?.ok()) throw new Error("Failed to load the Grow or Die build");
  await page.evaluate((runSeed) => {
    // Use the same starting save as Grow or Die's seeded flood scenario.
    localStorage.setItem(
      "growOrDie.save.v1",
      JSON.stringify({
        version: 1,
        runSeed,
        eventLog: [],
        state: {
          year: 1,
          population: 1000,
          highestPopulation: 1000,
          collapsed: false,
          collapseCause: null,
          arableLandHectares: 2000,
          preparedLandHectares: 400,
          storageTons: 2000,
          budgetCoins: 4000,
          worldPrice: 10,
          ownedTechnologies: [],
        },
      }),
    );
  }, inputs.seed);
  await page.reload({ timeout: 30000 });
  const year = page.locator("#stat-year");
  await year.filter({ hasText: /^1$/ }).waitFor();
  emit({ event: "launch", seed: inputs.seed });

  await page.locator("#plan-hectares").fill("400");
  await page.locator("#plan-fertilizer").fill("400");
  await page.locator("#confirm-btn").click();
  await page.locator("#allocation").waitFor();
  emit({
    event: "decision",
    step: 1,
    move: "resolve-harvest",
    cultivatedHectares: 400,
    fertilizedHectares: 400,
  });

  await page.locator("#plan-store").fill("600");
  await page.locator("#allocate-btn").click();
  await year.filter({ hasText: /^2$/ }).waitFor();
  await page
    .locator("#stat-storage")
    .filter({ hasText: /^600 t$/ })
    .waitFor();
  emit({
    event: "decision",
    step: 2,
    move: "finish-year",
    storedTons: 600,
  });
}

const {
  startGameServer,
}: {
  startGameServer: (settings: { port: number }) => Promise<Server>;
} = await import(pathToFileURL(path.join(build, "server.js")).href);

const server = await startGameServer({ port: 0 });
try {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No Grow or Die build server address");
  const browser = await chromium.launch({ timeout: 30000 });
  const deadline = setTimeout(() => {
    void browser.close().catch(() => undefined);
  }, 100000);
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    page.setDefaultTimeout(15000);
    try {
      await completeFirstYear(page, `http://127.0.0.1:${address.port}/`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      emit({ event: "milestone", turn: 1 });
    } catch (error) {
      await page
        .screenshot({ path: failureScreenshot, timeout: 10000 })
        .catch(() => undefined);
      throw error;
    }
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
