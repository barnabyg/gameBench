import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium, type Page } from "playwright";
import sirv from "sirv";
import { z } from "zod";
import { inspectPromotion } from "./promotion-layout.ts";

const { build, screenshot, failureScreenshot, inputs } = z
  .object({
    build: z.string(),
    screenshot: z.string(),
    failureScreenshot: z.string(),
    inputs: z.object({
      scenario: z.literal("first-promotion"),
      strategy: z.literal("seek-team-lead"),
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
  const deadline = setTimeout(() => {
    void browser.close().catch(() => undefined);
  }, 120000);
  try {
    const page = await browser.newPage({
      viewport: {
        width: inputs.settings.width,
        height: inputs.settings.height,
      },
      deviceScaleFactor: 1,
    });
    const query = new URLSearchParams({
      seed: String(inputs.seed),
      month: "7",
      choose: "take-the-blame,screenshot-on-the-note,word-with-the-analyst",
    });
    const url = new URL(`http://127.0.0.1:${address.port}/`);
    url.search = query.toString();
    try {
      const response = await page.goto(url.href, { timeout: 30000 });
      if (!response?.ok())
        throw new Error("Failed to load the Failureship build");
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
      await page.screenshot({
        path: screenshot,
        timeout: 15000,
        animations: "disabled",
      });
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
      event({ event: "milestone", turn });
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
