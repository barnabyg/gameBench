import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { seedSchema } from "./failureship-seeds.ts";

type Choice = {
  type: string;
  actionId?: string;
  optionId?: string;
  escapeId?: string;
};
type View = {
  job: { id: string };
  month: number;
  choices: Choice[];
  step: { kind: string };
  project: { real: string; reported: string };
  finalWarning: boolean;
};
type Engine = {
  gameContent: {
    events: { vacates?: unknown }[];
    project: { statuses: { id: string; label: string }[] };
  };
  startRun(options: { seed: number; content: Engine["gameContent"] }): {
    view(): View;
    choose(choice: Choice): View;
  };
  plainChoice(view: View): Choice;
};

const { build, inputs } = z
  .object({
    build: z.string(),
    inputs: z.object({
      scenario: z.enum(["company-events", "earned-vacancies"]),
      strategy: z.enum(["delivery-first", "politics-first", "adaptive"]),
      seed: seedSchema,
      settings: z.object({ withholdMove: z.string().nullable() }),
    }),
  })
  .parse(JSON.parse(readFileSync(0, "utf8")));
const engine: Engine = await import(pathToFileURL(build).href);
const green = engine.gameContent.project.statuses.find(
  (status) => status.id === "green",
)?.label;
if (!green) throw new Error("Build does not define the Green Project status");
const content =
  inputs.scenario === "earned-vacancies"
    ? {
        ...engine.gameContent,
        events: engine.gameContent.events.filter(
          (event) => event.vacates === undefined,
        ),
      }
    : engine.gameContent;
const run = engine.startRun({ seed: inputs.seed, content });
const delivery = [
  "take-the-blame",
  "deliver",
  "ask-analyst-for-figures",
  "load-the-real-figures",
];
const politics = [
  "take-the-blame",
  "screenshot-on-the-note",
  "claim-the-credit",
  "word-with-the-analyst",
];
let view = run.view();
const startingJob = view.job.id;
const moveOf = (choice: Choice) =>
  choice.optionId ?? choice.escapeId ?? choice.actionId ?? choice.type;
const emit = (record: unknown) => console.log(JSON.stringify(record));

for (let step = 1; step <= 1000; step++) {
  if (view.job.id !== startingJob) {
    emit({ event: "milestone", turn: view.month, decisions: step - 1 });
    break;
  }
  if (view.choices.length === 0) {
    emit({ event: "milestone-missed", turn: view.month });
    break;
  }
  if (step === 1000)
    throw new Error("Simulation exceeded its 999-choice limit");
  const priority =
    inputs.strategy === "adaptive"
      ? view.project.real === green &&
        view.project.reported === green &&
        !view.finalWarning
        ? politics
        : delivery
      : inputs.strategy === "politics-first"
        ? politics
        : delivery;
  const available = view.choices.filter(
    (choice) => moveOf(choice) !== inputs.settings.withholdMove,
  );
  const preferred = priority
    .map((move) => available.find((choice) => moveOf(choice) === move))
    .find(Boolean);
  const fallback = preferred ?? engine.plainChoice(view);
  const choice = available.includes(fallback)
    ? fallback
    : (available.find((option) => moveOf(option) === moveOf(fallback)) ??
      available[0]);
  if (!choice) throw new Error("No legal choice remained");
  if (choice.type !== "continue")
    emit({
      event: "decision",
      step,
      meaningful: available.length > 1,
      month: view.month,
      move: moveOf(choice),
      phase: view.step.kind,
      project: view.project.real,
      policy: priority === delivery ? "delivery" : "politics",
    });
  view = run.choose(choice);
}
