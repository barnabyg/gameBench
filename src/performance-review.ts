import type { Page } from "playwright";
import { z } from "zod";

const frameCount = 60;
const milliseconds = z.number().nonnegative();
export const performanceSettingsSchema = z.object({
  spikeAfterMs: z.number().positive(),
});
export const performanceSampleSchema = z.object({
  event: z.literal("performance-sample"),
  loadMs: milliseconds,
  frameMs: z.array(milliseconds).length(frameCount),
});
export type PerformanceSample = z.infer<typeof performanceSampleSchema> & {
  line: number;
};

export async function markBrowserStartup(page: Page) {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (
        !/7 of 18\b/.test(
          document.querySelector('[data-testid="month"]')?.textContent ?? "",
        )
      )
        return;
      performance.mark("gamebench-ready");
      observer.disconnect();
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

export async function sampleBrowserPerformance(page: Page) {
  return page.evaluate(async (count) => {
    const ready = performance.getEntriesByName("gamebench-ready", "mark")[0];
    if (!ready)
      throw new Error("The month header readiness mark was unavailable.");
    const nextFrame = () =>
      new Promise<number>((resolve) => requestAnimationFrame(resolve));
    let previous = await nextFrame();
    const frameMs: number[] = [];
    for (let frame = 0; frame < count; frame++) {
      const current = await nextFrame();
      frameMs.push(current - previous);
      previous = current;
    }
    return { event: "performance-sample", loadMs: ready.startTime, frameMs };
  }, frameCount);
}

type Measurement = {
  version: string;
  log: string;
  sample?: PerformanceSample;
};

function reportMs(value: number) {
  return Number(value.toFixed(3));
}

function describe({ version, log, sample }: Measurement, spikeAfterMs: number) {
  const evidence = { log, line: sample?.line ?? null };
  const frameMs = sample?.frameMs ?? [];
  return {
    load: {
      version,
      durationMs: sample ? reportMs(sample.loadMs) : null,
      evidence,
    },
    frames: {
      version,
      count: frameMs.length,
      maxMs: frameMs.length ? reportMs(Math.max(...frameMs)) : null,
      spikes: frameMs.flatMap((durationMs, index) =>
        durationMs >= spikeAfterMs
          ? [{ frame: index + 1, durationMs: reportMs(durationMs) }]
          : [],
      ),
      evidence,
    },
  };
}

function delta(baseline: number | null, candidate: number | null) {
  return baseline === null || candidate === null
    ? null
    : reportMs(candidate - baseline);
}

export function comparePerformance(
  baseline: Measurement,
  candidate: Measurement,
  spikeAfterMs: number,
) {
  const before = describe(baseline, spikeAfterMs);
  const after = describe(candidate, spikeAfterMs);
  return {
    unit: "ms",
    status: baseline.sample && candidate.sample ? "complete" : "incomplete",
    load: {
      interval: "navigation-to-month-header",
      baseline: before.load,
      candidate: after.load,
      deltaMs: delta(before.load.durationMs, after.load.durationMs),
    },
    frames: {
      interval: "first-promotion-notice",
      spikeAfterMs,
      baseline: before.frames,
      candidate: after.frames,
      deltaMaxMs: delta(before.frames.maxMs, after.frames.maxMs),
    },
  };
}
