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
