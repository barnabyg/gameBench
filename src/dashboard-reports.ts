import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const roles = ["baseline", "candidate"] as const;
const names = { baseline: "Baseline", candidate: "Candidate" };
export const areas = ["Balance", "Pacing", "Visuals", "Stability"] as const;
type Area = (typeof areas)[number];
type Status = "Passed" | "Review" | "Failed" | "Not measured";
type Evidence = { label: string; url: string; image: boolean };
type Finding = {
  summary: string;
  evidence: Evidence[];
  question?: string;
  status?: Status;
};
type Check = { status: Status; findings: Finding[]; regression?: boolean };
type Checks = Record<Area, Check>;
type Link = (label: string, file?: string) => Evidence[];
const nonempty = z.string().min(1);
const role = z.object({
  version: nonempty,
  status: z.enum(["reached", "missed", "failed"]),
  log: nonempty,
  screenshot: nonempty.optional(),
  error: z.string().optional(),
  turns: z.number().nullable().optional(),
});
const screen = z.object({
  screenshot: nonempty.optional(),
  reason: z.string().optional(),
});
const resolution = z.object({ width: z.number(), height: z.number() });
const interval = z.object({
  steps: z.number(),
  from: z.object({ move: nonempty, line: z.number() }),
  to: z.object({ move: nonempty, line: z.number() }),
});
const issues = z.array(
  z.object({
    type: z.string(),
    target: z.string(),
    other: z.string().optional(),
  }),
);
const reportSchema = z.object({
  inputs: z.object({
    scenario: nonempty,
    strategy: nonempty,
    seed: z.number(),
    settings: z.record(z.string(), z.json()),
  }),
  baseline: role,
  candidate: role,
  layout: z
    .object({
      status: z.enum(["passed", "failed"]),
      resolution: z.object({
        width: z.number().int().positive().catch(0),
        height: z.number().int().positive().catch(0),
      }),
      baseline: z.object({ issues: issues.nullable() }).optional(),
      candidate: z.object({ issues: issues.nullable() }),
    })
    .optional(),
  visualReview: z
    .object({
      checkpoints: z.array(
        z.object({
          label: nonempty,
          resolution,
          status: z.enum(["matched", "changed", "missing"]),
          baseline: screen,
          candidate: screen,
          diff: nonempty.optional(),
          changedPixelRatio: z.number().optional(),
        }),
      ),
      questions: z.array(z.string()).optional(),
    })
    .optional(),
  pacing: z
    .object({
      stallAfterSteps: z.number(),
      longest: z.object({
        baseline: interval.nullable(),
        candidate: interval.nullable(),
      }),
      stalls: z.object({ candidate: z.array(interval) }),
      changes: z.array(
        z.object({
          baseline: interval,
          candidate: interval,
          deltaSteps: z.number(),
        }),
      ),
    })
    .optional(),
});
const outcomes = z.object({
  promotions: z.number(),
  attempts: z.number(),
  rate: z.number(),
  failed: z.number(),
});
const batchSchema = z.object({
  baseline: nonempty,
  candidate: nonempty,
  seeds: z.array(z.number()),
  comparisons: z.array(
    z.object({
      scenario: nonempty,
      strategy: nonempty,
      baseline: outcomes,
      candidate: outcomes,
    }),
  ),
  cases: z.array(
    z.object({
      scenario: nonempty,
      strategy: nonempty,
      seed: z.number(),
      report: nonempty,
      withholdMove: z.boolean(),
    }),
  ),
  findings: z.array(
    z.object({
      role: z.enum(roles),
      move: nonempty,
      playtest: z.object({ task: nonempty, question: nonempty }),
      scenarios: z.array(
        z.object({
          scenario: nonempty,
          better: z.number(),
          worse: z.number(),
          paired: z.number(),
          evidence: z
            .object({
              report: nonempty,
              withoutMove: nonempty,
            })
            .nullable(),
        }),
      ),
    }),
  ),
});
const savedReport = z.union([reportSchema, batchSchema]);

export type DashboardReport = Awaited<ReturnType<typeof loadReport>>;

export async function loadReport(
  game: string,
  source: string,
  id: string,
  branch?: string,
) {
  const filename = await realpath(source);
  const directory = path.dirname(filename);
  const report = savedReport.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  const files = new Map<string, string>();
  function link(label: string, file?: string): Evidence[] {
    if (!file) return [];
    const absolute = path.resolve(directory, file);
    if (!inside(directory, absolute)) return [];
    const image = path.extname(file).toLowerCase() === ".png";
    const slot = String(files.size);
    files.set(slot, absolute);
    return [{ label, url: `/evidence/${id}/${slot}`, image }];
  }
  const checks =
    "inputs" in report
      ? comparisonChecks(report, link)
      : balanceChecks(report, link);
  return {
    data: {
      id,
      game,
      branch,
      checks,
      inputs:
        "inputs" in report
          ? report.inputs
          : {
              scenario: "Strategy batch",
              strategy: "Delivery-first, politics-first, adaptive",
              seeds: report.seeds,
            },
      baseline: "inputs" in report ? report.baseline.version : report.baseline,
      candidate:
        "inputs" in report ? report.candidate.version : report.candidate,
    },
    async evidence(slot: string) {
      const target = files.get(slot);
      if (!target) return;
      try {
        const resolved = await realpath(target);
        if (inside(directory, resolved) && (await stat(resolved)).isFile())
          return {
            path: resolved,
            image: path.extname(target).toLowerCase() === ".png",
          };
      } catch {
        return;
      }
    },
  };
}

function emptyChecks(): Checks {
  return {
    Balance: { status: "Not measured", findings: [] },
    Pacing: { status: "Not measured", findings: [] },
    Visuals: { status: "Not measured", findings: [] },
    Stability: { status: "Not measured", findings: [] },
  };
}

function comparisonChecks(report: z.infer<typeof reportSchema>, link: Link) {
  const logs = roles.flatMap((key) =>
    link(`${names[key]} log`, report[key].log),
  );
  const captures = roles.flatMap((key) =>
    link(`${names[key]} screenshot`, report[key].screenshot),
  );
  const checks = emptyChecks();
  checks.Stability = {
    status: report.candidate.status === "reached" ? "Passed" : "Failed",
    regression:
      report.baseline.status === "reached" &&
      report.candidate.status !== "reached",
    findings: [
      {
        summary:
          report.candidate.status === "reached"
            ? "Candidate reached the milestone."
            : report.candidate.status === "failed"
              ? "Candidate execution failed."
              : "Candidate missed the milestone.",
        evidence: [...logs, ...captures],
      },
    ],
  };
  if (report.candidate.error)
    checks.Stability.findings.push({
      summary: report.candidate.error,
      evidence: logs,
    });
  if (report.baseline.turns != null && report.candidate.turns != null)
    checks.Stability.findings.push({
      summary: `Milestone timing: ${report.baseline.turns} → ${report.candidate.turns} turns.`,
      evidence: logs,
    });
  if (report.baseline.status !== "reached") {
    checks.Stability.findings.push({
      summary: report.baseline.error ?? "Baseline missed the milestone.",
      evidence: logs,
    });
    if (checks.Stability.status === "Passed")
      checks.Stability.status = "Review";
  }
  if (report.pacing?.longest.candidate) {
    const pacing = report.pacing;
    const changes = [...pacing.changes].sort(
      (a, b) => b.deltaSteps - a.deltaSteps,
    );
    checks.Pacing = {
      status:
        pacing.stalls.candidate.length || changes.length ? "Review" : "Passed",
      regression: changes.some(
        ({ baseline, candidate }) =>
          baseline.steps < pacing.stallAfterSteps &&
          candidate.steps >= pacing.stallAfterSteps,
      ),
      findings: [
        ...changes.map(({ baseline, candidate, deltaSteps }) => ({
          summary: `${Math.abs(deltaSteps)} ${deltaSteps > 0 ? "more" : "fewer"} ${Math.abs(deltaSteps) === 1 ? "step" : "steps"} from ${candidate.from.move} to ${candidate.to.move} (${baseline.steps} → ${candidate.steps} steps).`,
          evidence: logs,
          question:
            deltaSteps > 0
              ? "Do the extra steps interrupt play between these two decisions?"
              : undefined,
        })),
        ...(pacing.stalls.candidate.length
          ? pacing.stalls.candidate
          : [report.pacing.longest.candidate]
        ).map((entry) => ({
          summary: `${entry.steps} steps from ${entry.from.move} to ${entry.to.move} (candidate log lines ${entry.from.line}–${entry.to.line}).`,
          evidence: logs,
        })),
      ],
    };
  }
  if (report.layout) {
    const {
      status,
      resolution: { width, height },
      candidate,
    } = report.layout;
    const baselineIssues = report.layout.baseline?.issues;
    const candidateIssues = candidate.issues ?? [];
    const issueKey = (issue: (typeof candidateIssues)[number]) =>
      JSON.stringify([issue.type, issue.target, issue.other]);
    const previous = new Set(baselineIssues?.map(issueKey));
    const newDefects = baselineIssues
      ? candidateIssues.filter((issue) => !previous.has(issueKey(issue)))
      : [];
    const layoutStatus = status === "passed" ? "Passed" : "Failed";
    const dimensions =
      width && height
        ? ` at ${width} × ${height}`
        : " (resolution unavailable)";
    checks.Visuals = {
      status: layoutStatus,
      regression: status === "failed" && newDefects.length > 0,
      findings: [
        {
          summary: newDefects.length
            ? `Promotion layout has ${newDefects.length} new ${newDefects.length === 1 ? "defect" : "defects"}${dimensions}.`
            : candidateIssues.length
              ? `Promotion layout has ${candidateIssues.length} ${candidateIssues.length === 1 ? "defect" : "defects"}${dimensions}.`
              : `Promotion layout ${status}${dimensions}.`,
          evidence: [...captures, ...logs],
          status: layoutStatus,
        },
        ...candidateIssues.map((issue): Finding => ({
          summary: [issue.type, issue.target, issue.other]
            .filter(Boolean)
            .join(" · "),
          evidence: [...captures, ...logs],
          status: layoutStatus,
        })),
      ],
    };
  }
  if (report.visualReview) {
    const { checkpoints } = report.visualReview;
    if (checks.Visuals.status !== "Failed") {
      if (checkpoints.some((item) => item.status !== "matched"))
        checks.Visuals.status = "Review";
      else if (checkpoints.length) checks.Visuals.status = "Passed";
    }
    const checkpointOrder = { changed: 0, missing: 1, matched: 2 };
    const sorted = [...checkpoints].sort(
      (a, b) => checkpointOrder[a.status] - checkpointOrder[b.status],
    );
    const visualFindings: Finding[] = [];
    for (const item of sorted) {
      const { width, height } = item.resolution;
      const outcome =
        item.status === "missing"
          ? [
              item.baseline.reason && `Baseline: ${item.baseline.reason}`,
              item.candidate.reason && `Candidate: ${item.candidate.reason}`,
            ]
              .filter(Boolean)
              .join(" ") || "A matched pair was unavailable."
          : `${((item.changedPixelRatio ?? 0) * 100).toLocaleString("en", { maximumSignificantDigits: 3 })}% changed pixels.`;
      visualFindings.push({
        summary: `${item.label} at ${width} × ${height}. ${outcome}`,
        status: item.status === "matched" ? "Passed" : "Review",
        question:
          item.status === "changed"
            ? report.visualReview.questions?.at(-1)
            : undefined,
        evidence: [
          ...roles.flatMap((key) =>
            link(`${names[key]} screenshot`, item[key].screenshot),
          ),
          ...link("Visual diff", item.diff),
          ...logs,
        ],
      });
    }
    if (checks.Visuals.status === "Review")
      checks.Visuals.findings.unshift(...visualFindings);
    else checks.Visuals.findings.push(...visualFindings);
  }
  return checks;
}

function balanceChecks(report: z.infer<typeof batchSchema>, link: Link) {
  const checks = emptyChecks();
  const comparisons = report.comparisons.toSorted(
    (a, b) =>
      Math.abs(b.candidate.rate - b.baseline.rate) -
      Math.abs(a.candidate.rate - a.baseline.rate),
  );
  if (!comparisons.length) return checks;
  const failed = comparisons.some((item) => item.candidate.failed);
  const review =
    report.findings.length > 0 ||
    comparisons.some(
      (item) =>
        item.candidate.rate !== item.baseline.rate || item.baseline.failed,
    );
  const format = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
  const findings = report.findings.flatMap((finding) =>
    finding.scenarios.map((item) => ({
      summary: `${names[finding.role]} · ${item.scenario} · ${finding.move} improved ${item.better} of ${item.paired} paired outcomes and worsened ${item.worse}.`,
      question: `${finding.playtest.task} ${finding.playtest.question}`,
      evidence: [
        ...link("Paired report", item.evidence?.report),
        ...link("Report with move withheld", item.evidence?.withoutMove),
      ],
    })),
  );
  checks.Balance = {
    status: failed ? "Failed" : review ? "Review" : "Passed",
    findings: [
      ...findings,
      ...comparisons.map(({ scenario, strategy, baseline, candidate }) => {
        const samples = report.cases.filter(
          (item) =>
            !item.withholdMove &&
            item.scenario === scenario &&
            item.strategy === strategy,
        );
        const delta = (candidate.rate - baseline.rate) * 100;
        return {
          summary: `${scenario} · ${strategy}: ${baseline.promotions}/${baseline.attempts} → ${candidate.promotions}/${candidate.attempts} promotions (${delta > 0 ? "+" : ""}${format.format(delta)} percentage points).${candidate.failed ? ` ${candidate.failed} candidate attempts failed to execute.` : ""}`,
          evidence: samples.flatMap((item) =>
            link(`Paired report for seed ${item.seed}`, item.report),
          ),
        };
      }),
    ],
  };
  return checks;
}

function inside(directory: string, filename: string) {
  const relation = path.relative(directory, filename);
  return (
    !!relation &&
    relation !== ".." &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation)
  );
}
