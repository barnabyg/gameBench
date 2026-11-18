import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const npmBuild = z.object({
  scripts: z.object({ build: z.string().trim().min(1) }),
});
const steps = ["build", "install", "checkout", "fetch", "init"];
export type BuildRole = "baseline" | "candidate";

export async function requireNpmBuild(checkout: string, role: BuildRole) {
  const pkg = npmBuild.safeParse(
    JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8")),
  );
  if (!pkg.success)
    throw new Error(
      `${role} checkout needs an npm build script for build smoke.`,
    );
  if (
    !["package-lock.json", "npm-shrinkwrap.json"].some((file) =>
      existsSync(path.join(checkout, file)),
    )
  )
    throw new Error(`${role} checkout needs an npm lockfile for build smoke.`);
}

export async function buildSmokeReport(
  directory: string,
  baselineVersion: string,
  candidateVersion: string,
  build: (role: BuildRole, version: string) => Promise<unknown>,
) {
  async function run(role: BuildRole, version: string) {
    try {
      await build(role, version);
      return { version, status: "reached", log: `${role}-build.log` };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const lastStep = steps
        .map((step) => `${role}-${step}.log`)
        .find((log) => existsSync(path.join(directory, log)));
      const log = `${role}-smoke.log`;
      const detail = lastStep
        ? await readFile(path.join(directory, lastStep), "utf8")
        : "";
      await writeFile(path.join(directory, log), `${error}\n\n${detail}`);
      return { version, status: "failed", log, error };
    }
  }

  const baseline = await run("baseline", baselineVersion);
  const candidate = await run("candidate", candidateVersion);
  const passed =
    baseline.status === "reached" && candidate.status === "reached";
  const report = path.join(directory, "report.json");
  await writeFile(
    report,
    JSON.stringify({
      kind: "build-smoke",
      status: passed ? "complete" : "incomplete",
      inputs: {
        scenario: "Build smoke",
        strategy: "npm ci + npm run build",
        seed: 0,
        settings: {},
      },
      baseline,
      candidate,
    }),
  );
  return { report, passed };
}
