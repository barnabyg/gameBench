import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { compare, buildSchema } from "./benchmark.ts";

const scenarios = ["company-events", "earned-vacancies"] as const;
const strategies = ["delivery-first", "politics-first", "adaptive"] as const;
const roles = ["baseline", "candidate"] as const;
const move = "screenshot-on-the-note";
const schema = z.object({
  adapter: z.string().min(1),
  baseline: buildSchema,
  candidate: buildSchema,
  seeds: z
    .array(z.int())
    .min(1)
    .max(100)
    .refine(
      (seeds) => new Set(seeds).size === seeds.length,
      "Seeds must be distinct",
    ),
});

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
      evidence: {
        seed: number;
        log: string;
        line: number;
        report: string;
        withoutMove: string;
      } | null;
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
          if (
            attempt[role].status !== "reached" &&
            control[role].status === "reached"
          )
            worse++;
          if (
            attempt[role].status !== "reached" ||
            control[role].status === "reached"
          )
            continue;
          const log = path.join(
            path.dirname(attempt.report),
            attempt[role].log,
          );
          const lines = (await readFile(path.join(directory, log), "utf8"))
            .trimEnd()
            .split("\n");
          const line = lines.findIndex((text) => {
            const event = JSON.parse(text);
            return event.event === "decision" && event.move === move;
          });
          if (line < 0) continue;
          better++;
          evidence ??= {
            seed: attempt.seed,
            log,
            line: line + 1,
            report: attempt.report,
            withoutMove: control.report,
          };
        }
        effects[role].push({ scenario, better, worse, paired, evidence });
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
          task: "At the Ideas Workshop, try putting a screenshot on the note. Replay the same seed and try a different option, then compare the first vacancy decisions.",
          question:
            "Could you explain why the seat was awarded, and was weighing the screenshot against actually doing the work engaging?",
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
