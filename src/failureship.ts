import { readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { type Browser, chromium, type Page } from "playwright";
import sirv from "sirv";
import { z } from "zod";
import { inspectPromotion } from "./promotion-layout.ts";
import { verifySaveResume } from "./save-resume.ts";
import { checkpoints, checkpointFile } from "./visual-checkpoints.ts";

const {
  build,
  screenshot,
  failureScreenshot,
  checkpointDirectory,
  checkpointResolution,
  inputs,
} = z
  .object({
    build: z.string(),
    screenshot: z.string(),
    failureScreenshot: z.string(),
    checkpointDirectory: z.string().optional(),
    checkpointResolution: z
      .object({ width: z.int().positive(), height: z.int().positive() })
      .optional(),
    inputs: z.object({
      scenario: z.enum(["first-promotion", "visual-review", "save-resume"]),
      strategy: z.enum(["seek-team-lead", "answer-and-resume"]),
      seed: z.int(),
      settings: z.object({
        checkLayout: z.boolean().optional(),
        width: z.int().positive(),
        height: z.int().positive(),
      }),
    }),
  })
  .parse(JSON.parse(readFileSync(0, "utf8")));

function event(value: unknown) {
  console.log(JSON.stringify(value));
}

async function runSaveResume(page: Page, origin: URL) {
  await openGame(page, origin, { month: "7" });
  await page
    .getByTestId("month")
    .filter({ hasText: /7 of 18\b/ })
    .waitFor({ timeout: 15_000 });
  const observation = await verifySaveResume(page);
  event(observation);
  const passed = observation.status === "passed";
  await page
    .screenshot({
      path: passed ? screenshot : failureScreenshot,
      timeout: 10_000,
      animations: "disabled",
    })
    .catch(() => undefined);
  event(
    passed ? { event: "milestone", turn: 7 } : { event: "milestone-missed" },
  );
}

async function reachPromotion(page: Page) {
  const promotion = page.getByTestId("decided-on-paper");
  const notice = page.getByTestId("panel-notice");
  const actions = [
    page
      .locator('[data-testid="panel-escape"] [data-testid^="escape-"]')
      .last(),
    page.getByTestId("panel-notification").getByTestId("option-report"),
    page
      .getByTestId("panel-notification")
      .locator('[data-testid^="option-"]:enabled', { hasText: "Costs nothing" })
      .first(),
    page.locator('[data-testid="inbox-item"][data-to-answer="true"]').first(),
    page
      .getByTestId("panel-scene")
      .locator('[data-testid^="scene-option-"]')
      .first(),
    page.getByTestId("continue"),
    page.locator('[data-testid^="hotspot-meeting"]:enabled').first(),
    page.getByTestId("hotspot-work").and(page.locator(":enabled")),
  ];
  const ready = actions.reduce((all, next) => all.or(next), promotion);
  for (let step = 0; step <= 80; step++) {
    await ready.first().waitFor({ state: "visible", timeout: 15000 });
    if (await promotion.isVisible()) {
      if (!(await notice.textContent())?.includes("Congratulations: Team lead"))
        throw new Error("The promotion decision did not award Team lead");
      return;
    }
    if (step === 80) break;
    for (const action of actions) {
      if (!(await action.isVisible())) continue;
      const id = await action.getAttribute("data-testid");
      await action.click();
      event({ event: "action", step: step + 1, id });
      break;
    }
  }
  throw new Error(
    "The first promotion screen was not reached within 80 actions",
  );
}

const viewport = checkpointResolution ?? {
  width: inputs.settings.width,
  height: inputs.settings.height,
};

async function openGame(
  page: Page,
  origin: URL,
  setup: Record<string, string>,
) {
  const url = new URL(origin);
  url.search = new URLSearchParams({
    seed: String(inputs.seed),
    ...setup,
  }).toString();
  const response = await page.goto(url.href, { timeout: 30000 });
  if (!response?.ok()) throw new Error("Failed to load the Failureship build");
}

async function capturePage(page: Page, filename: string) {
  await page.evaluate(() =>
    document.fonts.ready.then(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    ),
  );
  await page.screenshot({
    path: filename,
    timeout: 15000,
    animations: "disabled",
  });
}

async function captureFloors(browser: Browser, origin: URL, directory: string) {
  const floors = [
    {
      checkpoint: checkpoints.ground,
      month: 1,
      work: "hotspot-work",
      title: "Junior employee",
    },
    {
      checkpoint: checkpoints.top,
      month: 12,
      work: "hotspot-work-3",
      title: "Middle manager",
    },
  ];
  for (const floor of floors) {
    let page: Page | undefined;
    try {
      page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      const setup: Record<string, string> =
        floor.month === 1
          ? {}
          : {
              month: String(floor.month),
              choose:
                "take-the-blame,screenshot-on-the-note,claim-the-credit,word-with-the-analyst,sign-on-a-door,word-with-the-coordinator-2",
            };
      await openGame(page, origin, setup);
      await page
        .getByTestId("job-title")
        .filter({ hasText: floor.title })
        .waitFor({ timeout: 15000 });
      if (floor.checkpoint === checkpoints.top) {
        const arrival = page
          .getByTestId("panel-notice")
          .filter({ hasText: "Congratulations: Middle manager" });
        if (await arrival.isVisible())
          await arrival.getByTestId("continue").click();
        if (await page.getByTestId("lift-ride").isVisible())
          await page.getByTestId("lift-step-out").click();
        await arrival.waitFor({ state: "hidden", timeout: 15000 });
      }
      await page.getByTestId(floor.work).waitFor({ timeout: 15000 });
      await capturePage(
        page,
        path.join(directory, checkpointFile(floor.checkpoint)),
      );
      event({
        event: "visual-checkpoint",
        checkpoint: floor.checkpoint,
        month: floor.month,
      });
    } catch (error) {
      event({
        event: "visual-checkpoint-missing",
        checkpoint: floor.checkpoint,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
}

const server = createServer(sirv(build));
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No build server address");
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  function browserDeadline(milliseconds: number) {
    return setTimeout(() => {
      void browser.close().catch(() => undefined);
    }, milliseconds);
  }
  let deadline = browserDeadline(
    inputs.scenario === "visual-review" ? 90000 : 120000,
  );
  try {
    const origin = new URL(`http://127.0.0.1:${address.port}/`);
    if (inputs.scenario === "visual-review") {
      if (!checkpointDirectory)
        throw new Error("Visual review requires a checkpoint directory");
    }
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      if (inputs.scenario === "save-resume") {
        await runSaveResume(page, origin);
      } else {
        await openGame(page, origin, {
          month: "7",
          choose: "take-the-blame,screenshot-on-the-note,word-with-the-analyst",
        });
        event({ event: "launch", seed: inputs.seed });
        await page
          .getByTestId("month")
          .filter({ hasText: /7 of 18\b/ })
          .waitFor({ timeout: 15000 });
        await reachPromotion(page);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const first = inputs.settings.checkLayout
          ? await inspectPromotion(page)
          : [];
        await capturePage(page, screenshot);
        if (inputs.scenario === "visual-review" && checkpointDirectory) {
          await copyFile(
            screenshot,
            path.join(
              checkpointDirectory,
              checkpointFile(checkpoints.promotion),
            ),
          );
        }
        if (inputs.settings.checkLayout) {
          const second = await inspectPromotion(page);
          const issues = first.filter((issue) =>
            second.some(
              (other) =>
                other.type === issue.type &&
                other.target === issue.target &&
                other.other === issue.other,
            ),
          );
          event({
            event: "promotion-layout",
            resolution: page.viewportSize(),
            issues,
          });
        }
        const month = await page.getByTestId("month").textContent();
        const turn = Number(/(\d+) of 18\b/.exec(month ?? "")?.[1]);
        if (inputs.scenario === "visual-review" && checkpointDirectory) {
          clearTimeout(deadline);
          deadline = browserDeadline(30000);
          await captureFloors(browser, origin, checkpointDirectory);
        }
        event({ event: "milestone", turn });
      }
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
  server.close();
}
