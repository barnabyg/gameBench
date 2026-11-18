import { z } from "zod";

export const decisionSchema = z.object({
  event: z.literal("decision"),
  move: z.string().min(1),
  step: z.int().positive(),
  meaningful: z.boolean().default(true),
});
export type Decision = z.infer<typeof decisionSchema> & { line: number };
type Trace = {
  version: string;
  log: string;
  decisions: Decision[];
  status: string;
};

function intervals(trace: Trace) {
  const result = new Map<
    string,
    {
      version: string;
      log: string;
      steps: number;
      from: Decision;
      to: Decision;
    }
  >();
  const occurrences = new Map<string, number>();
  const decisions = trace.decisions.filter((decision) => decision.meaningful);
  for (const [index, from] of decisions.entries()) {
    const to = decisions[index + 1];
    if (!to) break;
    const pair = JSON.stringify([from.move, to.move]);
    const occurrence = (occurrences.get(pair) ?? 0) + 1;
    occurrences.set(pair, occurrence);
    result.set(`${pair}:${occurrence}`, {
      version: trace.version,
      log: trace.log,
      steps: to.step - from.step,
      from,
      to,
    });
  }
  return result;
}

export function comparePacing(
  baseline: Trace,
  candidate: Trace,
  stallAfterSteps: number,
) {
  const before = intervals(baseline);
  const after = intervals(candidate);
  const matched = [...before].flatMap(([key, previous]) => {
    const current = after.get(key);
    return current
      ? [
          {
            baseline: previous,
            candidate: current,
            deltaSteps: current.steps - previous.steps,
          },
        ]
      : [];
  });
  return {
    unit: "steps",
    stallAfterSteps,
    coverage: {
      baseline: baseline.status === "failed" ? "unavailable" : "recorded",
      candidate: candidate.status === "failed" ? "unavailable" : "recorded",
      matched: matched.length,
      unmatchedBaseline: before.size - matched.length,
      unmatchedCandidate: after.size - matched.length,
    },
    changes: matched.filter((change) => change.deltaSteps !== 0),
    stalls: {
      baseline: [...before.values()].filter(
        (interval) => interval.steps >= stallAfterSteps,
      ),
      candidate: [...after.values()].filter(
        (interval) => interval.steps >= stallAfterSteps,
      ),
    },
  };
}
