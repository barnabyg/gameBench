import { run } from "node:test";
import { spec } from "node:test/reporters";
import { pipeline } from "node:stream/promises";
const controller = new AbortController();
const tests = run({ signal: controller.signal });
tests.on("test:fail", () => {
  process.exitCode = 1;
  if (process.env.CI) controller.abort();
});
await pipeline(tests, new spec(), process.stdout);
