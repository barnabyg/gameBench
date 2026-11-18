import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { z } from "zod";
import { batch } from "./strategy-batch.ts";

const [baseline, candidate, ...requestedSeeds] = process.argv.slice(2);
if (!baseline || !candidate)
  throw new Error(
    "Usage: failureship:strategies <baseline checkout> <candidate checkout> [seed ...]",
  );
const seeds = z
  .array(z.int())
  .min(1)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Seeds must be distinct",
  )
  .parse(requestedSeeds.length ? requestedSeeds.map(Number) : [2, 14, 16, 23]);
const output = path.resolve("benchmark-runs");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "engines-"));
async function bundle(checkout: string, role: string) {
  const cwd = path.resolve(checkout);
  const version = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  }).trim();
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no", "--", "src", "content"],
    { cwd, encoding: "utf8", timeout: 15000 },
  ).trim();
  if (dirty)
    throw new Error(
      `Commit or set aside tracked game source changes in ${cwd} so the version names the tested code.`,
    );
  const outfile = path.join(directory, `${role}.mjs`);
  await build({
    stdin: {
      resolveDir: cwd,
      contents:
        'export {startRun} from "./src/engine/index.ts"; export {gameContent} from "./src/content/index.ts"; export {plainChoice} from "./src/ui/later-month.ts";',
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    nodePaths: [path.resolve("node_modules")],
  });
  return { build: outfile, version };
}
const [baselineBuild, candidateBuild] = await Promise.all([
  bundle(baseline, "baseline"),
  bundle(candidate, "candidate"),
]);
const manifest = path.join(directory, "batch.json");
await writeFile(
  manifest,
  `${JSON.stringify(
    {
      adapter: fileURLToPath(
        new URL("./failureship-simulation.ts", import.meta.url),
      ),
      baseline: baselineBuild,
      candidate: candidateBuild,
      seeds,
    },
    null,
    2,
  )}\n`,
);
await batch(manifest, output);
