import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const roles = ["baseline", "candidate"] as const;
const names = { baseline: "Baseline", candidate: "Candidate" };
export const areas = ["Balance", "Pacing", "Visuals", "Stability"] as const;
type Area = (typeof areas)[number];
type Status = "Passed" | "Review" | "Failed" | "Not measured";
type Evidence = { label: string; url: string; image: boolean };
type Finding = { summary: string; evidence: Evidence[] };
type Check = { status: Status; findings: Finding[] };
const nonempty = z.string().min(1);
const role = z.object({
  version: nonempty,
  status: z.enum(["reached", "missed", "failed"]),
  log: nonempty,
  screenshot: nonempty.optional(),
  error: z.string().optional(),
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
const issues = z.array(z.object({ type: z.string(), target: z.string() }));
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
      resolution,
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

export type DashboardReport = Awaited<ReturnType<typeof loadReport>>;

export async function loadReport(
  game: string,
  source: string,
  id: string,
  branch?: string,
) {
  const filename = await realpath(source);
  const directory = path.dirname(filename);
  const report = reportSchema.parse(
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
  const logs = roles.flatMap((key) =>
    link(`${names[key]} log`, report[key].log),
  );
  const captures = roles.flatMap((key) =>
    link(`${names[key]} screenshot`, report[key].screenshot),
  );
  const checks: Record<Area, Check> = {
    Balance: { status: "Not measured", findings: [] },
    Pacing: { status: "Not measured", findings: [] },
    Visuals: { status: "Not measured", findings: [] },
    Stability: {
      status: report.candidate.status === "reached" ? "Passed" : "Failed",
      findings: [
        {
          summary:
            report.candidate.status === "reached"
              ? "Candidate reached the milestone."
              : (report.candidate.error ?? "Candidate missed the milestone."),
          evidence: [...logs, ...captures],
        },
      ],
    },
  };
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
    checks.Pacing = {
      status: pacing.stalls.candidate.length ? "Review" : "Passed",
      findings: (pacing.stalls.candidate.length
        ? pacing.stalls.candidate
        : [report.pacing.longest.candidate]
      ).map((entry) => ({
        summary: `${entry.steps} steps from ${entry.from.move} to ${entry.to.move} (candidate log lines ${entry.from.line}–${entry.to.line}).`,
        evidence: logs,
      })),
    };
  }
  if (report.layout) {
    const {
      status,
      resolution: { width, height },
      candidate,
    } = report.layout;
    checks.Visuals = {
      status: status === "passed" ? "Passed" : "Failed",
      findings: [
        {
          summary: `Promotion layout ${status} at ${width} × ${height}.`,
          evidence: [...captures, ...logs],
        },
        ...(candidate.issues ?? []).map((issue) => ({
          summary: `${issue.type} · ${issue.target}`,
          evidence: [],
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
    for (const item of checkpoints) {
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
      checks.Visuals.findings.push({
        summary: `${item.label} at ${width} × ${height}. ${outcome}`,
        evidence: [
          ...roles.flatMap((key) =>
            link(`${names[key]} screenshot`, item[key].screenshot),
          ),
          ...link("Visual diff", item.diff),
        ],
      });
    }
  }
  return {
    data: {
      id,
      game,
      branch,
      checks,
      inputs: report.inputs,
      baseline: report.baseline.version,
      candidate: report.candidate.version,
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

function inside(directory: string, filename: string) {
  const relation = path.relative(directory, filename);
  return (
    !!relation &&
    relation !== ".." &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation)
  );
}
