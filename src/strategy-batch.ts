import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { compare, buildSchema } from "./benchmark.ts";
import { seedListSchema } from "./failureship-seeds.ts";

const scenarios = ["company-events", "earned-vacancies"] as const;
const strategies = ["delivery-first", "politics-first", "adaptive"] as const;
const roles = ["baseline", "candidate"] as const;
const move = "screenshot-on-the-note";
const schema = z.object({
  adapter: z.string().min(1),
  baseline: buildSchema,
  candidate: buildSchema,
  seeds: seedListSchema,
});

const playtest = {
  task: "At the Ideas Workshop, try putting a screenshot on the note. Replay the same seed and try a different option, then compare the first vacancy decisions.",
  question:
    "Could you explain why the seat was awarded, and was weighing the screenshot against actually doing the work engaging?",
};

type Outcome = Awaited<ReturnType<typeof compare>>["baseline"];
function summarize(outcomes: Outcome[]) {
  const turns = outcomes.flatMap((outcome) =>
    outcome.status === "reached" ? [outcome.turns] : [],
  );
  return {
    attempts: outcomes.length,
    promotions: turns.length,
    rate: turns.length / outcomes.length,
    turns,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
  };
}

export async function batch(source: string, output: string) {
  const manifest = schema.parse(JSON.parse(await readFile(source, "utf8")));
  const root = path.dirname(path.resolve(source));
  const adapter = path.resolve(root, manifest.adapter);
  const baseline = {
    ...manifest.baseline,
    build: path.resolve(root, manifest.baseline.build),
  };
  const candidate = {
    ...manifest.candidate,
    build: path.resolve(root, manifest.candidate.build),
  };
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.resolve(output, "strategies-"));
  async function run(
    scenario: (typeof scenarios)[number],
    strategy: (typeof strategies)[number],
    seed: number,
    withholdMove: boolean,
  ) {
    const inputs = {
      scenario,
      strategy,
      seed,
      settings: { withholdMove: withholdMove ? move : null },
    };
    const result = await compare(
      { adapter, baseline, candidate, inputs, pacing: { stallAfterSteps: 5 } },
      directory,
    );
    return {
      ...inputs,
      withholdMove,
      baseline: result.baseline,
      moveLine: {
        baseline: result.decisions.baseline.find(
          (decision) => decision.move === move,
        )?.line,
        candidate: result.decisions.candidate.find(
          (decision) => decision.move === move,
        )?.line,
      },
      candidate: result.candidate,
      report: path.relative(directory, result.path),
    };
  }
  const cases = [];
  const comparisons = [];
  const effects = { baseline: [], candidate: [] } as Record<
    (typeof roles)[number],
    {
      scenario: string;
      better: number;
      worse: number;
      paired: number;
      earlier: number;
      later: number;
      evidence: {
        seed: number;
        log: string;
        line: number;
        report: string;
        withoutMove: string;
      } | null;
      playtest?: typeof playtest;
    }[]
  >;
  for (const scenario of scenarios) {
    for (const strategy of strategies) {
      const regular = [];
      const withheld = [];
      for (const seed of manifest.seeds) {
        regular.push(await run(scenario, strategy, seed, false));
        if (strategy === "politics-first")
          withheld.push(await run(scenario, strategy, seed, true));
      }
      cases.push(...regular, ...withheld);
      comparisons.push({
        scenario,
        strategy,
        baseline: summarize(regular.map((attempt) => attempt.baseline)),
        candidate: summarize(regular.map((attempt) => attempt.candidate)),
      });
      if (strategy !== "politics-first") continue;
      for (const role of roles) {
        let better = 0;
        let worse = 0;
        let paired = 0;
        let earlier = 0;
        let later = 0;
        let evidence = null;
        for (const [index, attempt] of regular.entries()) {
          const control = withheld[index];
          if (
            !control ||
            attempt[role].status === "failed" ||
            control[role].status === "failed"
          )
            continue;
          paired++;
          const normalTurn = attempt[role].turns;
          const controlTurn = control[role].turns;
          if (
            controlTurn !== null &&
            (normalTurn === null || normalTurn > controlTurn)
          ) {
            worse++;
            if (normalTurn !== null) later++;
          }
          const line = attempt.moveLine[role];
          if (
            normalTurn === null ||
            (controlTurn !== null && normalTurn >= controlTurn) ||
            line === undefined
          )
            continue;
          better++;
          if (controlTurn !== null) earlier++;
          const log = path.join(
            path.dirname(attempt.report),
            attempt[role].log,
          );
          evidence ??= {
            seed: attempt.seed,
            log,
            line,
            report: attempt.report,
            withoutMove: control.report,
          };
        }
        effects[role].push({
          scenario,
          better,
          worse,
          paired,
          earlier,
          later,
          evidence,
          ...(evidence && better > worse ? { playtest } : {}),
        });
      }
    }
  }
  const findings = roles.flatMap((role) => {
    const data = effects[role];
    const evidence = data[0]?.evidence;
    if (
      !evidence ||
      !data.every(
        (row) => row.paired === manifest.seeds.length && row.better > row.worse,
      )
    )
      return [];
    return [
      {
        role,
        move,
        scenarios: data,
        playtest: {
          scenario: data[0]?.scenario,
          seed: evidence.seed,
          ...playtest,
        },
      },
    ];
  });
  const status = cases.some((attempt) =>
    roles.some((role) => attempt[role].status === "failed"),
  )
    ? "incomplete"
    : "complete";
  const report = path.join(directory, "batch-report.json");
  await writeFile(
    report,
    `${JSON.stringify(
      {
        status,
        seeds: manifest.seeds,
        baseline: baseline.version,
        candidate: candidate.version,
        comparisons,
        cases,
        effects,
        findings,
      },
      null,
      2,
    )}\n`,
  );
  console.log(report);
  if (status === "incomplete") process.exitCode = 1;
}
if (import.meta.main) {
  const [source, output = "benchmark-runs"] = process.argv.slice(2);
  try {
    if (!source)
      throw new Error("Usage: strategy-batch <batch.json> [output directory]");
    await batch(source, output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
