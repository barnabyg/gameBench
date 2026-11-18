import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { layoutSchema } from "./promotion-layout.ts";
import { reviewVisuals, visualReviewSchema } from "./visual-review.ts";
import { comparePacing, decisionSchema, type Decision } from "./pacing.ts";

export const buildSchema = z.object({
  version: z.string().min(1),
  build: z.string().min(1),
});
const manifestSchema = z.object({
  adapter: z.string().min(1),
  baseline: buildSchema,
  candidate: buildSchema,
  visualReview: visualReviewSchema.optional(),
  pacing: z.object({ stallAfterSteps: z.int().positive() }).optional(),
  inputs: z.object({
    scenario: z.string().min(1),
    strategy: z.string().min(1),
    seed: z.int(),
    settings: z.record(z.string(), z.json()),
  }),
});

export async function compare(
  manifest: z.infer<typeof manifestSchema>,
  output: string,
) {
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.resolve(output, "run-"));
  async function save(name: string, value: unknown) {
    await writeFile(
      path.join(directory, name),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  await save("replay.json", manifest);
  const layouts: Partial<
    Record<"baseline" | "candidate", z.infer<typeof layoutSchema>>
  > = {};
  const decisions = { baseline: [] as Decision[], candidate: [] as Decision[] };
  async function run(role: "baseline" | "candidate") {
    const build = manifest[role];
    const screenshot = `${role}-milestone.png`;
    const failureScreenshot = `${role}-failure.png`;
    const checkpointDirectory = manifest.visualReview
      ? path.join(directory, role)
      : undefined;
    if (checkpointDirectory) await mkdir(checkpointDirectory);
    const result = spawnSync(process.execPath, [manifest.adapter], {
      encoding: "utf8",
      input: JSON.stringify({
        build: build.build,
        inputs: manifest.inputs,
        checkpointDirectory,
        screenshot: path.join(directory, screenshot),
        failureScreenshot: path.join(directory, failureScreenshot),
      }),
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const log = `${role}.ndjson`;
    await writeFile(path.join(directory, log), result.stdout ?? "");
    const evidence = { version: build.version, log };
    try {
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = result.stderr.trim();
        throw new Error(
          `Adapter ended with ${result.signal ?? `exit code ${result.status}`}${detail ? `: ${detail}` : ""}`,
        );
      }
      const lines = result.stdout.replace(/\r?\n$/, "").split("\n");
      let lastEvent: Record<string, unknown> | undefined;
      let previousStep = 0;
      for (const [index, line] of lines.entries()) {
        try {
          lastEvent = z.record(z.string(), z.unknown()).parse(JSON.parse(line));
          if (
            manifest.inputs.settings.checkLayout === true &&
            lastEvent.event === "promotion-layout"
          )
            layouts[role] = layoutSchema.parse(lastEvent);
          if (manifest.pacing && lastEvent.event === "decision") {
            const decision = decisionSchema.parse(lastEvent);
            if (decision.step <= previousStep)
              throw new Error("Decision steps must increase");
            previousStep = decision.step;
            decisions[role].push({ ...decision, line: index + 1 });
          }
        } catch {
          throw new Error(
            `Invalid event in ${path.join(directory, log)} at line ${index + 1}`,
          );
        }
      }
      if (
        z.object({ event: z.literal("milestone-missed") }).safeParse(lastEvent)
          .success
      )
        return { ...evidence, status: "missed" as const, turns: null };
      const milestone = z
        .object({ event: z.literal("milestone"), turn: z.int().nonnegative() })
        .safeParse(lastEvent);
      if (!milestone.success)
        throw new Error("Adapter finished without a valid milestone");
      return {
        ...evidence,
        status: "reached" as const,
        turns: milestone.data.turn,
        ...(await linkScreenshot(screenshot)),
      };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      console.error(
        `${role} (${build.version}) failed: ${error}. Evidence: ${directory}`,
      );
      return {
        ...evidence,
        status: "failed" as const,
        turns: null,
        error,
        ...(await linkScreenshot(failureScreenshot)),
      };
    }
  }
  async function linkScreenshot(screenshot: string) {
    const captured = await access(path.join(directory, screenshot)).then(
      () => true,
      () => false,
    );
    return captured ? { screenshot } : {};
  }
  const baseline = await run("baseline");
  const candidate = await run("candidate");
  const reached = [baseline, candidate].filter(
    ({ status }) => status === "reached",
  ).length;
  const complete = baseline.turns !== null && candidate.turns !== null;
  const layout =
    manifest.inputs.settings.checkLayout === true
      ? {
          status:
            layouts.candidate &&
            layouts.candidate.issues.length === 0 &&
            layouts.candidate.resolution.width ===
              manifest.inputs.settings.width &&
            layouts.candidate.resolution.height ===
              manifest.inputs.settings.height &&
            layouts.baseline?.resolution.width ===
              manifest.inputs.settings.width &&
            layouts.baseline?.resolution.height ===
              manifest.inputs.settings.height
              ? "passed"
              : "failed",
          resolution: {
            width: manifest.inputs.settings.width,
            height: manifest.inputs.settings.height,
          },
          baseline: {
            version: baseline.version,
            issues: layouts.baseline?.issues ?? null,
          },
          candidate: {
            version: candidate.version,
            issues: layouts.candidate?.issues ?? null,
          },
        }
      : undefined;
  if (layout?.status === "failed")
    console.error(`Promotion layout check failed. Evidence: ${directory}`);
  await save("report.json", {
    ...(layout ? { layout } : {}),
    ...(manifest.visualReview
      ? {
          visualReview: await reviewVisuals(directory, manifest.visualReview, {
            baseline: baseline.version,
            candidate: candidate.version,
          }),
        }
      : {}),
    status: complete ? "complete" : "incomplete",
    inputs: manifest.inputs,
    baseline,
    candidate,
    outcomes: { attempted: 2, reached, missing: 2 - reached },
    changeInTurns: complete ? candidate.turns - baseline.turns : null,
    replay: "replay.json",
    ...(manifest.pacing
      ? {
          pacing: comparePacing(
            {
              ...baseline,
              decisions: baseline.status === "failed" ? [] : decisions.baseline,
            },
            {
              ...candidate,
              decisions:
                candidate.status === "failed" ? [] : decisions.candidate,
            },
            manifest.pacing.stallAfterSteps,
          ),
        }
      : {}),
  });
  return {
    path: path.join(directory, "report.json"),
    baseline,
    candidate,
    complete,
    passed: complete && layout?.status !== "failed",
    decisions,
  };
}
if (import.meta.main) {
  try {
    const [source, output = "benchmark-runs"] = process.argv.slice(2);
    if (!source)
      throw new Error("Usage: benchmark <comparison.json> [output directory]");
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(source, "utf8")),
    );
    const root = path.dirname(path.resolve(source));
    manifest.adapter = path.resolve(root, manifest.adapter);
    for (const build of [manifest.baseline, manifest.candidate])
      build.build = path.resolve(root, build.build);
    const result = await compare(manifest, output);
    console.log(result.path);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
