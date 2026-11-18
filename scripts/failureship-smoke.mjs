import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [
  baseline,
  baselineVersion,
  candidate,
  candidateVersion,
  width = "1280",
  height = "800",
] = process.argv.slice(2);
if (!baseline || !baselineVersion || !candidate || !candidateVersion) {
  console.error(
    "Usage: npm run failureship:smoke -- <baseline dist> <baseline version> <candidate dist> <candidate version> [width] [height]",
  );
  process.exit(1);
}

const output = path.resolve("benchmark-runs");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "failureship-"));
const manifest = path.join(directory, "comparison.json");
await writeFile(
  manifest,
  JSON.stringify({
    adapter: fileURLToPath(new URL("../src/failureship.ts", import.meta.url)),
    baseline: { build: path.resolve(baseline), version: baselineVersion },
    candidate: { build: path.resolve(candidate), version: candidateVersion },
    inputs: {
      scenario: "first-promotion",
      strategy: "seek-team-lead",
      seed: 2,
      settings: {
        width: Number(width),
        height: Number(height),
        checkLayout: true,
      },
    },
  }),
);
const run = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../src/benchmark.ts", import.meta.url)),
    manifest,
    directory,
  ],
  { stdio: "inherit", timeout: 420000 },
);
if (run.error) console.error(run.error.message);
process.exitCode = run.status ?? 1;
