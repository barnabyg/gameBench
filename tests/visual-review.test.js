import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
test("report changes and missing checkpoints without failing the visual review", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "visual review "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, "comparison.json");
  await writeFile(
    path.join(root, "adapter.mjs"),
    `
  import {readFileSync,writeFileSync} from "node:fs";
  import path from "node:path";
  import pngjs from ${JSON.stringify(pathToFileURL(require.resolve("pngjs")).href)};
  const {PNG}=pngjs;
  const {build,checkpointDirectory}=JSON.parse(readFileSync(0,"utf8"));
  function capture(id,red,width=32){
    const image=new PNG({width,height:24});
    for(let offset=0;offset<image.data.length;offset+=4){image.data[offset]=red;image.data[offset+3]=255;}
    writeFileSync(path.join(checkpointDirectory,id+".png"),PNG.sync.write(image));
  }
  capture("ground-floor",build.endsWith("base")?0:255);
  capture("promotion",40);
  capture("top-floor",20,build.endsWith("base")?32:31);
  console.log(JSON.stringify({event:"milestone",turn:8}));
 `,
  );
  await writeFile(
    manifest,
    JSON.stringify({
      adapter: "adapter.mjs",
      baseline: { build: "base", version: "base" },
      candidate: { build: "new", version: "new" },
      inputs: {
        scenario: "visual-review",
        strategy: "seek-team-lead",
        seed: 2,
        settings: {},
      },
      visualReview: { width: 32, height: 24, changedPixelRatio: 0.005 },
    }),
  );
  const reportPath = execFileSync(
    process.execPath,
    ["src/benchmark.ts", manifest, root],
    { encoding: "utf8", timeout: 420000 },
  ).trim();
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const rows = Object.fromEntries(
    report.visualReview.checkpoints.map((row) => [row.checkpoint, row]),
  );
  assert.equal(rows["ground-floor"].status, "changed");
  assert.equal(rows["ground-floor"].changedPixels, 768);
  assert.deepEqual(rows["ground-floor"].resolution, { width: 32, height: 24 });
  for (const file of [
    rows["ground-floor"].baseline.screenshot,
    rows["ground-floor"].candidate.screenshot,
    rows["ground-floor"].diff,
  ])
    await access(path.join(path.dirname(reportPath), file));
  assert.equal(rows.promotion.status, "matched");
  assert.equal(rows.penthouse.status, "missing");
  assert.equal(rows.penthouse.candidate.status, "missing");
  assert.equal(rows["top-floor"].candidate.status, "invalid");
  assert.ok(
    report.visualReview.questions.some((question) =>
      question.includes("posher"),
    ),
  );
});

test("capture the three playable checkpoints through the Failureship browser adapter", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser checkpoints "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "index.html"),
    `<!doctype html><title>Checkpoint fixture</title><body><script>
  const month = new URLSearchParams(location.search).get("month");
  if (month === "7") document.body.innerHTML = '<span data-testid="month">7 of 18</span><section data-testid="panel-notice">Congratulations: Team lead<p data-testid="decided-on-paper">Standing</p></section>';
  else if (month === "12") document.body.innerHTML = '<h1 data-testid="job-title">Middle manager</h1><button data-testid="hotspot-work-3">Corner office</button><section data-testid="panel-notice">Congratulations: Middle manager<button data-testid="continue" onclick="this.parentNode.remove()">Continue</button></section>';
  else document.body.innerHTML = '<h1 data-testid="job-title">Junior employee</h1><button data-testid="hotspot-work">Desk</button>';
 </script>`,
  );
  const manifest = path.join(root, "comparison.json");
  await writeFile(
    manifest,
    JSON.stringify({
      adapter: path.resolve("src/failureship.ts"),
      baseline: { build: root, version: "base" },
      candidate: { build: root, version: "new" },
      inputs: {
        scenario: "visual-review",
        strategy: "seek-team-lead",
        seed: 2,
        settings: { width: 320, height: 200 },
      },
      visualReview: { width: 640, height: 400, changedPixelRatio: 0.005 },
    }),
  );
  const file = execFileSync(
    process.execPath,
    ["src/benchmark.ts", manifest, root],
    { encoding: "utf8", timeout: 420000 },
  ).trim();
  const report = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(
    report.visualReview.checkpoints.map(({ checkpoint, status }) => [
      checkpoint,
      status,
    ]),
    [
      ["ground-floor", "matched"],
      ["promotion", "matched"],
      ["penthouse", "missing"],
      ["top-floor", "matched"],
    ],
  );
  const logs = (
    await readFile(path.join(path.dirname(file), report.candidate.log), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(logs[0].event, "launch");
  assert.equal(logs.at(-1).event, "milestone");
  const png = await readFile(
    path.join(
      path.dirname(file),
      report.visualReview.checkpoints[0].candidate.screenshot,
    ),
  );
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [640, 400]);
});
