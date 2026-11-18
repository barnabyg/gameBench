import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const dashboard = fileURLToPath(
  new URL("../src/dashboard.ts", import.meta.url),
);
const repository = "benchmark-fixtures/harvest";
const missingRecipe = "benchmark-fixtures/missing-recipe";
const branch = "dev/tuning";

async function createGame(directory) {
  const checkout = path.join(directory, "upstream");
  await mkdir(checkout);
  function git(...args) {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=Dashboard Test",
        "-c",
        "user.email=dashboard@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: checkout, encoding: "utf8", timeout: 15_000 },
    ).trim();
  }
  git("init", "-q", "-b", "main");
  const identity = { name: "harvest-fixture", version: "1.0.0" };
  await writeFile(
    path.join(checkout, "package.json"),
    JSON.stringify({
      ...identity,
      scripts: { build: "node --version" },
    }),
  );
  await writeFile(
    path.join(checkout, "package-lock.json"),
    JSON.stringify({
      ...identity,
      lockfileVersion: 3,
      packages: { "": identity },
    }),
  );
  const turnFile = path.join(checkout, "turn.txt");
  async function commit(turns) {
    await writeFile(turnFile, String(turns));
    git("add", ".");
    git("commit", "-qm", `Set milestone to ${turns} turns`);
    return git("rev-parse", "HEAD");
  }
  const baseline = await commit(3);
  git("switch", "-qc", branch);
  const candidate = await commit(5);
  const config = path.join(directory, "games.json");
  const adapter = path.join(directory, "adapter.mjs");
  await writeFile(
    adapter,
    `
    import { readFileSync } from "node:fs";
    import path from "node:path";
    const { build } = JSON.parse(readFileSync(0, "utf8"));
    const turn = Number(readFileSync(path.join(build, "turn.txt"), "utf8"));
    console.log(JSON.stringify({ event: "milestone", turn }));
  `,
  );
  const recipe = {
    repository,
    baseline,
    build: { output: "." },
    comparison: {
      adapter,
      inputs: { scenario: "harvest", strategy: "store", seed: 7, settings: {} },
    },
  };
  await writeFile(config, JSON.stringify({ games: [recipe] }));
  return { baseline, candidate, checkout, config, commit, git, recipe };
}

async function githubFixture(directory) {
  const executable = path.join(
    directory,
    process.platform === "win32" ? "gh.exe" : "gh",
  );
  // The Node executable runs the local “api” script when the application calls gh api.
  await link(process.execPath, executable).catch(() =>
    copyFile(process.execPath, executable),
  );
  await writeFile(
    path.join(directory, "api"),
    `
    const { execFileSync } = require("node:child_process");
    const endpoint = process.argv[2];
    let result;
    if (endpoint === "user/repos") {
      result = [[
        { name:"harvest", full_name:${JSON.stringify(repository)}, default_branch:"main" },
        { name:"missing-recipe", full_name:${JSON.stringify(missingRecipe)}, default_branch:"main" },
      ]];
    } else if (endpoint.endsWith("branches?per_page=100")) {
      const refs = execFileSync("git", ["-C", "upstream", "for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding:"utf8" }).trim();
      result = refs.split(/\\r?\\n/).map((name) => [{ name }]);
    } else if (endpoint.includes("/commits/")) {
      const revision = endpoint.split("/commits/")[1];
      result = { sha: execFileSync("git", ["-C", "upstream", "rev-parse", "--verify", revision + "^{commit}"], { encoding:"utf8" }).trim() };
    } else if (endpoint.includes("/git/ref/heads/")) {
      const ref = decodeURIComponent(endpoint.split("/git/ref/heads/")[1]);
      result = execFileSync("git", ["-C", "upstream", "rev-parse", "refs/heads/" + ref], { encoding:"utf8" }).trim();
    } else {
      throw new Error("Unexpected GitHub endpoint " + endpoint);
    }
    console.log(JSON.stringify(result));
  `,
  );
}

async function launch(directory, game, configured = true) {
  const child = spawn(
    process.execPath,
    [
      dashboard,
      ...(configured ? ["--config", game.config] : []),
      "--output",
      path.join(directory, "runs"),
      "--port",
      "0",
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: directory + path.delimiter + process.env.PATH,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(game.checkout).href}.insteadOf`,
        GIT_CONFIG_VALUE_0: `https://github.com/${repository}.git`,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const stopped = new Promise((resolve) => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout });
  const stop = async () => {
    child.kill();
    await stopped;
  };
  try {
    const { value: url } = await lines[Symbol.asyncIterator]().next();
    assert.match(url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/$/);
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test(
  "sets up a selected repository during its run and reuses the setup after restart",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-setup-"));
    let server;
    let browser;
    try {
      const game = await createGame(directory);
      await githubFixture(directory);
      const recipeDirectory = path.join(directory, "runs", "setup-recipes");
      const recipeFile = path.join(
        recipeDirectory,
        "repo-benchmark-fixtures.harvest.json",
      );
      await mkdir(recipeDirectory, { recursive: true });
      await writeFile(
        recipeFile,
        JSON.stringify({
          ...game.recipe,
          comparison: { ...game.recipe.comparison, adapter: "missing.mjs" },
        }),
      );
      server = await launch(directory, game, false);
      browser = await chromium.launch();
      const page = await browser.newPage();
      const picker = page.getByRole("list", { name: "GitHub repositories" });
      const repo = picker.getByRole("listitem").filter({ hasText: repository });
      const checkbox = repo.getByRole("checkbox");
      const run = page.getByRole("button", { name: "Run selected" });
      await page.goto(server.url);
      await page.getByRole("link", { name: "Repositories" }).click();
      await repo.getByText("Needs setup").waitFor();
      assert.ok(await checkbox.isEnabled());
      await checkbox.check();
      await picker.getByRole("checkbox", { name: missingRecipe }).check();
      await run.click();
      await page
        .getByText(/Adapter file is unavailable.*missing\.mjs/)
        .waitFor();
      await page
        .getByText(/Add a trusted recipe.*missing-recipe\.json/)
        .waitFor();
      await repo.getByText("Needs setup").waitFor();

      await writeFile(
        recipeFile,
        JSON.stringify({
          ...game.recipe,
          build: { output: "../checkout/dist" },
        }),
      );
      await run.click();
      await page.getByText(/Set build\.output.*inside the checkout/).waitFor();
      await repo.getByText("Needs setup").waitFor();

      await writeFile(
        recipeFile,
        JSON.stringify({
          ...game.recipe,
          comparison: {
            ...game.recipe.comparison,
            adapter: path.relative(
              recipeDirectory,
              game.recipe.comparison.adapter,
            ),
          },
        }),
      );
      await run.click();
      await repo.getByText("Ready", { exact: true }).waitFor();
      await page
        .getByRole("link", { name: "Open report" })
        .click({ timeout: 45_000 });
      await page
        .locator("#finding")
        .getByText(game.baseline, { exact: true })
        .first()
        .waitFor();

      await rm(recipeFile);
      await server.stop();
      server = await launch(directory, game, false);
      await page.goto(server.url);
      await page.getByRole("link", { name: "Repositories" }).click();
      await repo.getByText("Ready", { exact: true }).waitFor();
      await checkbox.check();
      await run.click();
      await page
        .getByRole("link", { name: "Open report" })
        .waitFor({ timeout: 45_000 });
    } finally {
      await browser?.close();
      await server?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "runs the selected branch and keeps its exact commit when the branch advances",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-branch-"));
    let server;
    let browser;
    try {
      const game = await createGame(directory);
      await githubFixture(directory);
      server = await launch(directory, game);
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      await page.getByRole("link", { name: "Repositories" }).click();
      await page.getByRole("checkbox", { name: repository }).check();
      const picker = page.getByRole("combobox", {
        name: `Candidate branch for ${repository}`,
      });
      assert.equal(await picker.inputValue(), "");
      await picker.selectOption(branch);
      let failedStatusRead = false;
      let startedRun = false;
      await page.route("**/api/runs", async (route) => {
        if (route.request().method() === "POST") startedRun = true;
        else if (startedRun && !failedStatusRead) {
          failedStatusRead = true;
          await route.fulfill({
            status: 502,
            json: { error: "Temporary failure" },
          });
          return;
        }
        await route.continue();
      });
      await page
        .getByRole("searchbox", { name: "Search repositories" })
        .fill("no matching repository");
      await page.getByText("No matching repositories").waitFor();
      const selection = page.getByRole("group", {
        name: "Repository selection",
      });
      await selection.getByText("1 selected", { exact: true }).waitFor();
      await selection.getByRole("button", { name: "Run selected" }).click();
      await page.getByText(/Run status temporarily unavailable/).waitFor();
      assert.ok(
        await page.getByRole("button", { name: "Run selected" }).isDisabled(),
      );
      await page
        .getByRole("link", { name: "Open report" })
        .click({ timeout: 45_000 });
      const finding = page.locator("#finding");
      for (const value of [
        branch,
        game.baseline,
        game.candidate,
        "3 → 5 turns",
      ])
        await finding
          .getByText(value, { exact: value !== "3 → 5 turns" })
          .waitFor();

      const advanced = await game.commit(8);
      assert.notEqual(advanced, game.candidate);
      const newBranch = "dev/new-run";
      game.git("branch", newBranch);
      await page
        .getByRole("searchbox", { name: "Search repositories" })
        .fill("");
      const disclosure = page.getByText("GitHub repositories", { exact: true });
      await disclosure.click();
      await disclosure.click();
      await picker
        .getByRole("option", { name: newBranch, includeHidden: true })
        .waitFor({ state: "attached" });
      await server.stop();
      server = await launch(directory, game);
      await page.goto(server.url);
      await page.getByRole("button", { name: "Stability: Passed" }).click();
      await finding.getByText(game.candidate, { exact: true }).waitFor();
      assert.equal(
        await finding.getByText(advanced, { exact: true }).count(),
        0,
      );
    } finally {
      await browser?.close();
      await server?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
