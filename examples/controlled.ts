import { readFileSync } from "node:fs";
import { z } from "zod";

const { build, inputs } = z
  .object({
    build: z.string(),
    inputs: z.object({
      scenario: z.literal("first-delivery"),
      strategy: z.literal("deliver"),
      seed: z.int(),
      settings: z.object({ pace: z.int().positive() }),
    }),
  })
  .parse(JSON.parse(readFileSync(0, "utf8")));
const { distance } = z
  .object({ distance: z.int().positive().max(10000) })
  .parse(JSON.parse(readFileSync(build, "utf8")));
const destination = distance + Math.abs(inputs.seed % 2);
let turn = 0;
console.log(JSON.stringify({ event: "decision", step: 1, move: "dispatch" }));
for (
  let travelled = 0;
  travelled < destination;
  travelled += inputs.settings.pace
) {
  turn++;
  console.log(
    JSON.stringify({
      event: "delivery",
      scenario: inputs.scenario,
      turn,
      progress: Math.min(travelled + inputs.settings.pace, destination),
    }),
  );
}
console.log(
  JSON.stringify({
    event: "decision",
    step: Math.max(2, turn),
    move: "confirm-delivery",
  }),
);
console.log(JSON.stringify({ event: "milestone", turn }));
