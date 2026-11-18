import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { visualReviewSchema } from "./visual-review.ts";

const repositoryName = z
  .string()
  .regex(/^[a-z\d-]+\/[a-z\d_.-]+$/i)
  .refine(
    (name) => !name.endsWith("/.") && !name.endsWith("/.."),
    "Invalid GitHub repository name",
  );
const commitId = z.string().regex(/^[a-f\d]{40}$/i);
const recipeSchema = z.object({
  repository: repositoryName,
  baseline: commitId,
  build: z.object({
    args: z.array(z.string()).default([]),
    output: z.string().min(1),
  }),
  comparison: z.object({
    adapter: z.string().min(1),
    inputs: z.object({
      scenario: z.string().min(1),
      strategy: z.string().min(1),
      seed: z.int(),
      settings: z.record(z.string(), z.json()),
    }),
    visualReview: visualReviewSchema.optional(),
    pacing: z.object({ stallAfterSteps: z.int().positive() }).optional(),
  }),
});
type Recipe = z.infer<typeof recipeSchema>;
const catalogSchema = z.array(
  z.array(
    z.object({
      name: z.string(),
      full_name: repositoryName,
      default_branch: z.string().min(1),
    }),
  ),
);

const failureship: Recipe = {
  repository: "barnabyg/failureship",
  // biome-ignore lint/security/noSecrets: Public Git revision pinned by the Failureship CI pilot. Revisit if this baseline changes.
  baseline: "f6c354054ab0f48413d9c1ce1aa35f518b70d2a3",
  build: {
    args: ["--mode", "e2e", "--outDir", "dist-benchmark"],
    output: "dist-benchmark",
  },
  comparison: {
    adapter: fileURLToPath(new URL("./failureship.ts", import.meta.url)),
    inputs: {
      scenario: "visual-review",
      strategy: "seek-team-lead",
      seed: 2,
      settings: { width: 1280, height: 800, checkLayout: true },
    },
    visualReview: { width: 1280, height: 800, changedPixelRatio: 0.005 },
  },
};

const seconds = 1_000;
const githubTimeout = 90 * seconds;
const checkoutTimeout = 300 * seconds;
const buildTimeout = 900 * seconds;
const benchmarkTimeout = 600 * seconds;
const maxCommandOutput = 16 * 1024 * 1024;

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function terminate(child: ReturnType<typeof spawn>) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile(
      "taskkill.exe",
      ["/pid", String(child.pid), "/T", "/F"],
      {
        windowsHide: true,
        timeout: 30 * seconds,
      },
      () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
    );
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};
function command(
  executable: string,
  args: string[],
  options: { timeout: number; cwd?: string; env?: NodeJS.ProcessEnv },
) {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let error: string | undefined;
    let outputBytes = 0;
    const timer = setTimeout(() => {
      error = `Timed out after ${options.timeout / seconds} seconds`;
      terminate(child);
    }, options.timeout);
    function collect(stream: "stdout" | "stderr", chunk: string) {
      if (error) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxCommandOutput) {
        error = "Command output exceeded 16 MiB";
        terminate(child);
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    }
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => collect("stdout", chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => collect("stderr", chunk));
    child.once("error", (cause) => {
      error = cause.message;
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    });
  });
}

function assertSuccess(
  result: CommandResult,
  label: string,
  evidence?: string,
) {
  if (result.status === 0 && !result.error) return;
  const detail =
    result.error ??
    (evidence
      ? `Exit code ${result.status}`
      : result.stderr.trim().slice(-600) || `Exit code ${result.status}`);
  throw new Error(`${label}: ${detail}${evidence ? `. See ${evidence}.` : ""}`);
}

async function logged(
  executable: string,
  args: string[],
  options: Parameters<typeof command>[2],
  evidence: string,
) {
  const result = await command(executable, args, options);
  await writeFile(
    evidence,
    [result.stdout, result.stderr, result.error].filter(Boolean).join("\n"),
  );
  return result;
}

const nonInteractive = {
  ...process.env,
  GH_PROMPT_DISABLED: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const gitEnvironment = {
  ...nonInteractive,
  // Preserve the caller's Git and npm configuration, but never persist a credential helper in the checkout.
  GCM_INTERACTIVE: "never",
};
const checkoutGitOptions = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.https://github.com.helper=!gh auth git-credential",
];
const buildEnvironment: NodeJS.ProcessEnv = { ...nonInteractive };
for (const name of Object.keys(buildEnvironment)) {
  if (
    [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
    ].includes(name.toUpperCase())
  )
    delete buildEnvironment[name];
}

function npmCommand(args: string[]): [string, string[]] {
  const npmCli = process.env.npm_execpath;
  if (npmCli && path.basename(npmCli) === "npm-cli.js")
    return [process.execPath, [npmCli, ...args]];
  if (process.platform !== "win32") return ["npm", args];
  const bundled = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(bundled)) return [process.execPath, [bundled, ...args]];
  throw new Error(
    "Launch the dashboard with npm.cmd run dashboard so Node can locate the npm CLI.",
  );
}

export class DashboardRunner {
  private configPath: string | undefined;
  private outputRoot: string;

  constructor(configPath: string | undefined, outputRoot: string) {
    this.configPath = configPath && path.resolve(configPath);
    this.outputRoot = path.resolve(outputRoot);
  }

  private async games() {
    const games = new Map([[failureship.repository, failureship]]);
    if (this.configPath) {
      const directory = path.dirname(this.configPath);
      const config = z
        .object({ games: z.array(recipeSchema) })
        .parse(JSON.parse(await readFile(this.configPath, "utf8")));
      for (const game of config.games) {
        games.set(game.repository.toLowerCase(), {
          ...game,
          comparison: {
            ...game.comparison,
            adapter: path.resolve(directory, game.comparison.adapter),
          },
        });
      }
    }
    return games;
  }

  private async api(endpoint: string, args: string[] = []) {
    const result = await command("gh", ["api", endpoint, ...args], {
      timeout: githubTimeout,
      env: nonInteractive,
    });
    assertSuccess(result, "GitHub CLI request failed");
    return result.stdout;
  }

  async repositories() {
    const [games, response] = await Promise.all([
      this.games(),
      this.api("user/repos", ["--paginate", "--slurp"]),
    ]);
    const repositories = catalogSchema.parse(JSON.parse(response)).flat();
    return repositories.map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      ready: games.has(repo.full_name.toLowerCase()),
    }));
  }

  async run(
    fullName: string,
    defaultBranch: string,
    onProgress: (message: string) => void,
  ) {
    const repository = repositoryName.parse(fullName);
    const recipe = (await this.games()).get(repository.toLowerCase());
    if (!recipe) throw new Error(`${repository} needs benchmark setup.`);

    onProgress("Resolving default branch");
    const candidate = commitId.parse(
      JSON.parse(
        await this.api(
          `repos/${repository}/commits/${encodeURIComponent(defaultBranch)}`,
          ["--jq", ".sha | @json"],
        ),
      ),
    );
    await mkdir(this.outputRoot, { recursive: true });
    const directory = await mkdtemp(path.join(this.outputRoot, "dashboard-"));

    const build = async (role: "baseline" | "candidate", version: string) => {
      const checkout = path.join(directory, role);
      await mkdir(checkout);
      const output = path.resolve(checkout, recipe.build.output);
      if (!inside(checkout, output))
        throw new Error("The build output must stay inside the checkout.");

      const git = async (step: string, args: string[]) => {
        const evidence = path.join(directory, `${role}-${step}.log`);
        const result = await logged(
          "git",
          [...checkoutGitOptions, ...args],
          {
            timeout: checkoutTimeout,
            cwd: checkout,
            env: gitEnvironment,
          },
          evidence,
        );
        assertSuccess(result, `${role} Git ${step} failed`, evidence);
      };
      onProgress(`Checking out ${role}`);
      await git("init", ["init", "--quiet"]);
      await git("fetch", [
        "fetch",
        "--depth=1",
        "--no-tags",
        "--",
        `https://github.com/${repository}.git`,
        version,
      ]);
      await git("checkout", ["checkout", "--quiet", "--detach", version]);

      const npm = async (step: string, args: string[]) => {
        const [executable, argv] = npmCommand(args);
        const evidence = path.join(directory, `${role}-${step}.log`);
        const result = await logged(
          executable,
          argv,
          {
            timeout: buildTimeout,
            cwd: checkout,
            env: buildEnvironment,
          },
          evidence,
        );
        assertSuccess(result, `${role} ${step} failed`, evidence);
      };
      onProgress(`Installing ${role} dependencies`);
      await npm("install", ["ci", "--no-audit", "--no-fund"]);
      onProgress(`Building ${role}`);
      await npm("build", ["run", "build", "--", ...recipe.build.args]);
      const actualOutput = await realpath(output);
      if (
        !inside(await realpath(checkout), actualOutput) ||
        !(await stat(actualOutput)).isDirectory()
      )
        throw new Error(
          `${role} build output is not a directory inside the checkout.`,
        );
      return { build: actualOutput, version };
    };

    const baseline = await build("baseline", recipe.baseline);
    const candidateBuild = await build("candidate", candidate);
    onProgress("Comparing baseline and candidate");
    const manifest = path.join(directory, "comparison.json");
    await writeFile(
      manifest,
      JSON.stringify(
        {
          ...recipe.comparison,
          baseline,
          candidate: candidateBuild,
        },
        null,
        2,
      ),
    );
    const benchmark = fileURLToPath(new URL("./benchmark.ts", import.meta.url));
    const evidence = path.join(directory, "benchmark.log");
    const result = await logged(
      process.execPath,
      [benchmark, manifest, directory],
      {
        timeout: benchmarkTimeout,
        env: buildEnvironment,
      },
      evidence,
    );
    const report = result.stdout.trim().split(/\r?\n/).at(-1);
    if (
      report &&
      path.isAbsolute(report) &&
      inside(directory, report) &&
      path.basename(report) === "report.json" &&
      (await stat(report).catch(() => undefined))?.isFile()
    )
      return {
        reports: [report],
        passed: result.status === 0 && !result.error,
      };

    assertSuccess(result, "Benchmark failed", evidence);
    throw new Error(`Benchmark finished without a report. See ${evidence}.`);
  }
}
