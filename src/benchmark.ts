import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const buildSchema = z.object({
  version: z.string().min(1),
  build: z.string().min(1),
});
const manifestSchema = z.object({
  adapter: z.string().min(1),
  baseline: buildSchema,
  candidate: buildSchema,
  inputs: z.object({
    scenario: z.string().min(1),
    strategy: z.string().min(1),
    seed: z.int(),
    settings: z.record(z.string(), z.json()),
  }),
});

async function compare(source: string, output: string) {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(source, "utf8")),
  );
  const root = path.dirname(path.resolve(source));
  manifest.adapter = path.resolve(root, manifest.adapter);
  for (const build of [manifest.baseline, manifest.candidate])
    build.build = path.resolve(root, build.build);
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.resolve(output, "run-"));
  async function save(name: string, value: unknown) {
    await writeFile(
      path.join(directory, name),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  await save("replay.json", manifest);
  async function run(role: "baseline" | "candidate") {
    const build = manifest[role];
    const result = spawnSync(process.execPath, [manifest.adapter], {
      encoding: "utf8",
      input: JSON.stringify({ build: build.build, inputs: manifest.inputs }),
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const log = `${role}.ndjson`;
    await writeFile(path.join(directory, log), result.stdout ?? "");
    if (result.error || result.status !== 0)
      throw new Error(
        `${role} (${build.version}) failed: ${result.error?.message ?? result.stderr}. Evidence: ${directory}`,
      );
    const lines = result.stdout.replace(/\r?\n$/, "").split("\n");
    let lastEvent: unknown;
    for (const [index, line] of lines.entries()) {
      try {
        lastEvent = z.record(z.string(), z.unknown()).parse(JSON.parse(line));
      } catch {
        throw new Error(
          `Invalid event in ${path.join(directory, log)} at line ${index + 1}`,
        );
      }
    }
    const milestone = z
      .object({ event: z.literal("milestone"), turn: z.int().nonnegative() })
      .parse(lastEvent);
    return { version: build.version, turns: milestone.turn, log };
  }
  const baseline = await run("baseline");
  const candidate = await run("candidate");
  await save("report.json", {
    baseline,
    candidate,
    changeInTurns: candidate.turns - baseline.turns,
    replay: "replay.json",
  });
  return path.join(directory, "report.json");
}
try {
  const [source, output = "benchmark-runs"] = process.argv.slice(2);
  if (!source)
    throw new Error("Usage: benchmark <comparison.json> [output directory]");
  console.log(await compare(source, output));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
