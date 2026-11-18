import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  buildSmokeReport,
  type BuildRole,
  requireNpmBuild,
} from "./dashboard-build-smoke.ts";
import { command, type CommandResult } from "./dashboard-command.ts";
import { comparisonBaselineSchema } from "./dashboard-reports.ts";
import { visualReviewSchema } from "./visual-review.ts";

const repositoryName = z
  .string()
  .regex(/^[a-z\d-]+\/[a-z\d_.-]+$/i)
  .refine(
    (name) => !name.endsWith("/.") && !name.endsWith("/.."),
    "Invalid GitHub repository name",
  );
const commitId = z.string().regex(/^[a-f\d]{40}$/i);
const recipeIdentity = z.object({
  repository: repositoryName,
  baseline: commitId,
});
const buildSmokeRecipeSchema = recipeIdentity.extend({
  buildSmoke: z.literal(true),
});
const recipeSchema = recipeIdentity.extend({
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
const savedRecipeSchema = z.union([buildSmokeRecipeSchema, recipeSchema]);
type SavedRecipe = z.infer<typeof savedRecipeSchema>;
const buildSmokeOptions = { args: [], output: "." };
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
const growOrDie: Recipe = {
  repository: "barnabyg/growOrDie",
  // biome-ignore lint/security/noSecrets: Public Git revision pinned for the first-harvest benchmark. Revisit if this baseline changes.
  baseline: "0795b888812d5bfa45244062b63ec3fba1994652",
  build: { args: [], output: "." },
  comparison: {
    adapter: fileURLToPath(new URL("./grow-or-die.ts", import.meta.url)),
    inputs: {
      scenario: "first-harvest",
      strategy: "store-surplus",
      seed: 29,
      settings: {},
    },
    pacing: { stallAfterSteps: 5 },
  },
};

const seconds = 1_000;
const githubTimeout = 90 * seconds;
const checkoutTimeout = 300 * seconds;
const buildTimeout = 900 * seconds;
const benchmarkTimeout = 600 * seconds;

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function escapesCheckout(output: string) {
  const relative = path.normalize(output);
  return (
    Boolean(path.parse(relative).root) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  );
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
  private setupState: string;
  private setupSources: string;
  private savedRecipes = new Map<string, SavedRecipe>();

  constructor(configPath: string | undefined, outputRoot: string) {
    this.configPath = configPath && path.resolve(configPath);
    this.outputRoot = path.resolve(outputRoot);
    this.setupState = path.join(this.outputRoot, "dashboard-setup");
    this.setupSources = path.join(this.outputRoot, "setup-recipes");
  }

  async restoreSetups() {
    await mkdir(this.setupState, { recursive: true });
    const entries = await readdir(this.setupState, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^repo-.+\.json$/.test(entry.name)) continue;
      try {
        const recipe = savedRecipeSchema.parse(
          JSON.parse(
            await readFile(path.join(this.setupState, entry.name), "utf8"),
          ),
        );
        const key = recipe.repository.toLowerCase();
        if (
          entry.name !== this.recipeFilename(key) ||
          ("comparison" in recipe &&
            !path.isAbsolute(recipe.comparison.adapter))
        )
          throw new Error(
            "The saved recipe has the wrong repository or adapter path.",
          );
        this.savedRecipes.set(key, recipe);
      } catch (error) {
        console.error(`Saved setup ${entry.name} is unavailable:`, error);
      }
    }
  }

  private recipeFilename(key: string) {
    return `repo-${key.replace("/", ".")}.json`;
  }

  private async games() {
    const games = new Map<string, SavedRecipe>(
      [failureship, growOrDie].map((game) => [
        game.repository.toLowerCase(),
        game,
      ]),
    );
    for (const [key, recipe] of this.savedRecipes) games.set(key, recipe);
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

  private async recipeFor(fullName: string) {
    const repository = repositoryName.parse(fullName);
    return (await this.games()).get(repository.toLowerCase());
  }

  private async prepareSetup(
    fullName: string,
    allowBuildSmoke: boolean,
    onProgress: (message: string) => void,
  ) {
    onProgress("Validating benchmark setup.");
    const key = repositoryName.parse(fullName).toLowerCase();
    const source = path.join(this.setupSources, this.recipeFilename(key));
    let recipe: Recipe;
    try {
      recipe = recipeSchema.parse(JSON.parse(await readFile(source, "utf8")));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        if (allowBuildSmoke) return;
        throw new Error(
          `Add a trusted recipe at ${source} or reload the dashboard to approve build smoke.`,
        );
      }
      const detail =
        error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      throw new Error(`Could not read benchmark recipe ${source}: ${detail}`);
    }
    if (recipe.repository.toLowerCase() !== key)
      throw new Error(
        `Set the repository in ${source} to ${fullName} and retry.`,
      );
    const adapter = path.resolve(
      path.dirname(source),
      recipe.comparison.adapter,
    );
    if (!(await stat(adapter).catch(() => undefined))?.isFile())
      throw new Error(
        `Adapter file is unavailable: ${adapter}. Correct ${source} and retry.`,
      );
    if (escapesCheckout(recipe.build.output))
      throw new Error(
        `Set build.output in ${source} to a path inside the checkout and retry.`,
      );
    await this.api(
      `repos/${fullName}/commits/${recipe.baseline}`,
      ["--jq", ".sha"],
      `Could not verify the baseline commit for ${fullName}. Check ${source} and retry`,
    );

    return {
      ...recipe,
      repository: fullName,
      comparison: { ...recipe.comparison, adapter },
    };
  }

  private async confirmSetup(recipe: SavedRecipe, report: string) {
    try {
      const { baseline } = comparisonBaselineSchema.parse(
        JSON.parse(await readFile(report, "utf8")),
      );
      if (baseline.status === "failed")
        return "Setup could not be saved because the baseline did not run. Open the report for evidence, correct the recipe and retry.";
      await this.saveSetup(recipe);
    } catch (error) {
      return `Could not save benchmark setup. Open the report for evidence and retry. ${String(error)}`;
    }
  }

  private async saveSetup(recipe: SavedRecipe) {
    const key = recipe.repository.toLowerCase();
    const destination = path.join(this.setupState, this.recipeFilename(key));
    const pending = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(pending, JSON.stringify(recipe));
      await rename(pending, destination);
    } finally {
      await rm(pending, { force: true });
    }
    this.savedRecipes.set(key, recipe);
  }

  private async api(
    endpoint: string,
    args: string[] = [],
    errorLabel = "GitHub CLI request failed",
  ) {
    const result = await command("gh", ["api", endpoint, ...args], {
      timeout: githubTimeout,
      env: nonInteractive,
    });
    assertSuccess(result, errorLabel);
    return result.stdout;
  }

  async repositories() {
    const [games, response, sources] = await Promise.all([
      this.games(),
      this.api("user/repos", ["--paginate", "--slurp"]),
      readdir(this.setupSources).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }),
    ]);
    const staged = new Set(sources);
    const repositories = catalogSchema.parse(JSON.parse(response)).flat();
    return repositories.map((repo) => {
      const key = repo.full_name.toLowerCase();
      const ready = games.has(key);
      return {
        name: repo.name,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        ready,
        needsBuildSmokeApproval:
          !ready && !staged.has(this.recipeFilename(key)),
      };
    });
  }

  async branches(fullName: string) {
    const recipe = await this.recipeFor(fullName);
    if (!recipe) throw new Error(`${fullName} needs benchmark setup.`);
    const { repository } = recipe;
    const response = await this.api(
      `repos/${repository}/branches?per_page=100`,
      ["--paginate", "--slurp"],
      `Could not list branches for ${repository}`,
    );
    const pages = z
      .array(z.array(z.object({ name: z.string().min(1) })))
      .parse(JSON.parse(response));
    return pages.flatMap((page) => page.map(({ name }) => name));
  }

  async run(
    fullName: string,
    branch: string,
    allowBuildSmoke: boolean,
    onProgress: (message: string) => void,
  ) {
    const configured = await this.recipeFor(fullName);
    const prepared =
      configured ??
      (await this.prepareSetup(fullName, allowBuildSmoke, onProgress));
    const repository = prepared?.repository ?? fullName;

    onProgress(`Resolving branch ${branch}`);
    const candidate = commitId.parse(
      JSON.parse(
        await this.api(
          `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
          ["--jq", ".object.sha | @json"],
          `Could not resolve branch ${JSON.stringify(branch)} for ${repository}`,
        ),
      ),
    );
    const recipe: SavedRecipe = prepared ?? {
      repository,
      baseline: candidate,
      buildSmoke: true,
    };
    const smoke = "buildSmoke" in recipe;
    const options = smoke ? buildSmokeOptions : recipe.build;
    await mkdir(this.outputRoot, { recursive: true });
    const directory = await mkdtemp(path.join(this.outputRoot, "dashboard-"));

    const build = async (role: BuildRole, version: string) => {
      const checkout = path.join(directory, role);
      await mkdir(checkout);
      if (escapesCheckout(options.output))
        throw new Error("The build output must stay inside the checkout.");
      const output = path.resolve(checkout, options.output);

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
      const packageFile = await stat(path.join(checkout, "package.json")).catch(
        () => undefined,
      );
      if (!packageFile?.isFile())
        throw new Error(`${role} checkout has no package.json to build.`);
      if (smoke) await requireNpmBuild(checkout, role);

      const npm = async (step: string, args: string[]) => {
        const [executable, argv] = npmCommand(["--prefix", checkout, ...args]);
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
      await npm("build", ["run", "build", "--", ...options.args]);
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

    if (smoke) {
      const { report, passed } = await buildSmokeReport(
        directory,
        recipe.baseline,
        candidate,
        build,
      );
      const setupError =
        !configured && !passed
          ? "Build smoke failed before setup could be saved. Open the report for evidence and retry."
          : configured
            ? undefined
            : await this.confirmSetup(recipe, report);
      return {
        reports: [report],
        passed,
        setupComplete: !configured && !setupError,
        setupError,
      };
    }

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
    ) {
      const setupError = configured
        ? undefined
        : await this.confirmSetup(recipe, report);
      return {
        reports: [report],
        passed: result.status === 0 && !result.error,
        setupComplete: !configured && !setupError,
        setupError,
      };
    }

    assertSuccess(result, "Benchmark failed", evidence);
    throw new Error(`Benchmark finished without a report. See ${evidence}.`);
  }
}
