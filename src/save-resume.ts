import type { Page } from "playwright";
import { z } from "zod";

const stateSchema = z.object({
  month: z.string().min(1),
  remaining: z.string().min(1),
  result: z.string().min(1),
});
export const resumeEventSchema = z.object({
  event: z.literal("save-resume"),
  status: z.enum(["passed", "failed"]),
  step: z.enum(["save", "reload", "continue"]),
  before: stateSchema.optional(),
  after: stateSchema.optional(),
  reason: z.string().optional(),
});
export type ResumeEvent = z.infer<typeof resumeEventSchema>;

const timeout = 15_000;
export async function verifySaveResume(page: Page): Promise<ResumeEvent> {
  const inbox = page.getByTestId("open-inbox");
  const panel = page.getByTestId("panel-result");
  const answer = panel.getByTestId("answer-result");
  const nextMessage = page
    .locator('[data-testid="inbox-item"][data-to-answer="true"]:enabled')
    .first();
  const notification = page.getByTestId("panel-notification");
  const choices = notification.locator('[data-testid^="option-"]:enabled');
  async function snapshot() {
    return stateSchema.parse({
      month: (await page.getByTestId("month").textContent({ timeout }))?.trim(),
      remaining: (await inbox.textContent({ timeout }))?.trim(),
      result: (await answer.textContent({ timeout }))?.trim(),
    });
  }
  let step: ResumeEvent["step"] = "save";
  let before: ResumeEvent["before"];
  let after: ResumeEvent["after"];
  try {
    const initial = await inbox.textContent({ timeout });
    await inbox.click({ timeout });
    await nextMessage.click({ timeout });
    await choices.first().click({ timeout });
    before = await snapshot();
    if (!initial?.trim() || before.remaining === initial.trim())
      throw new Error(
        "Answering the notification did not change the inbox count.",
      );

    step = "reload";
    // Remove the E2E setup parameters so it cannot recreate the saved state.
    await page.evaluate(() =>
      history.replaceState(null, "", location.pathname),
    );
    const response = await page.reload({ timeout: 30_000 });
    if (!response?.ok())
      throw new Error("Reload did not return a playable page.");
    const lost = page.getByTestId("save-lost");
    await answer.or(lost).first().waitFor({ timeout });
    if (await lost.isVisible())
      throw new Error("The game reported that its save could not be resumed.");
    after = await snapshot();
    if (
      before.month !== after.month ||
      before.remaining !== after.remaining ||
      before.result !== after.result
    )
      throw new Error(
        "The reloaded game did not restore the saved month, inbox count and answer result.",
      );

    step = "continue";
    await panel.getByTestId("continue").click({ timeout });
    await panel.waitFor({ state: "hidden", timeout });
    await nextMessage.click({ timeout });
    await notification.waitFor({ timeout });
    if (!(await choices.first().isVisible()))
      throw new Error("The next notification did not offer an enabled answer.");
    return { event: "save-resume", status: "passed", step, before, after };
  } catch (error) {
    return {
      event: "save-resume",
      status: "failed",
      step,
      before,
      after,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
