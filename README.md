# Game Build Benchmark

Compare a candidate build with a baseline under the same scenario, strategy, settings, and random seed. This first slice includes a controlled delivery scenario.

## Try the comparison

From the repository root in PowerShell 7 with Node.js 24.13 or later, run:

```powershell
npm.cmd ci && npm.cmd run --silent benchmark -- examples/comparison.json
```

Open the printed report path. The baseline delivers on turn 4 and the candidate on turn 6. The reported change is +2 turns. Open each linked NDJSON log beside the report to see the actions. Each run gets its own directory.

To replay, pass that directory's `replay.json` to the same benchmark command. Replay resolves the recorded absolute adapter and build paths on this machine. Keep those files and versions available. An optional second argument selects the output directory.

## Adapter contract

A comparison manifest names a trusted local Node adapter and two builds, each with a version and path. Paths resolve relative to the manifest. The runner starts the adapter in a fresh Node process once per build and supplies one JSON object on standard input with the absolute `build` path and the shared `inputs` object. For browser evidence, the input also supplies absolute `screenshot` and `failureScreenshot` paths. Write a PNG to the applicable path before exiting. The runner links the file if present. The adapter writes one JSON gameplay event per line to standard output and finishes a successful scenario with a milestone event carrying a non-negative integer `turn`. A completed run that missed the checkpoint ends with a `milestone-missed` event and exits zero. In a batch this counts as an attempted promotion with no success. The single-comparison command exits nonzero if either build misses its checkpoint. Send diagnostics to standard error and exit nonzero on adapter failure. The example manifests and adapter form a runnable reference.

## Verification

Run `npm.cmd run verify` from the repository root. It checks formatting, lint (including secret detection), strict types, command-level tests, dependency advisories and the npm package contents. TypeScript executes directly on Node, so there is no compilation or bundling step.

## Failureship first-promotion check

From the gameBench root, with Node.js 24.13 or later and two Failureship builds produced with `npm.cmd run build -- --mode e2e` in their respective checkouts, run:

```powershell
npm.cmd ci && npx.cmd playwright install chromium && npm.cmd run failureship:smoke -- C:/builds/baseline/dist BASELINE_SHA C:/builds/candidate/dist CANDIDATE_SHA 1280 800
```

Replace the example paths and version identifiers with your builds. The last two arguments are the viewport width and height in pixels. The check opens a fresh browser for each build, starts seed 2 at month 7 using the game's E2E setup, and plays through the promotion decision. Expect the Team lead notice in both screenshots linked by the report. The command exits nonzero if the required outcome fails. The evidence directory includes the replay manifest, action logs, and a screenshot of the failed browser state when it can be captured.

Pull requests run this same command against two pinned Failureship commits. Download the `failureship-first-promotion` artifact from the check to inspect its evidence.

## Incomplete comparisons

If either build exits early or misses the milestone, the runner still attempts both builds and prints the report path before returning a nonzero exit code. The report includes the scenario and seed, both builds' statuses and logs, and counts of attempted, reached, and missing milestones. A missing milestone has a null turn count, and the comparison has a null turn difference.

## Failureship strategy batch

From the gameBench root, with Node.js 24.13 or later and two clean Failureship Git checkouts at the revisions to compare with dependencies installed by `npm.cmd ci` in each, run:

```powershell
npm.cmd ci && npm.cmd run failureship:strategies -- C:/game/baseline C:/game/candidate 2 14 16 23
```

The command bundles each checkout's actual engine and records its Git revision. Open the printed batch report. Each strategy has four attempts per build in each of two scenarios. The report shows promotion counts and rates, months for successful promotions, and paths to paired reports and replay manifests. The default seeds are 2, 14, 16 and 23. Keep the generated engine bundles for replay.

Delivery-first prioritises real Project work. Politics-first prioritises doing the Grand Plan for show, claiming credit and talking to the Senior Analyst. Adaptive favours delivery when real or reported Project status drops below Green or the player is on a Final Warning. The batch compares normal Company Events with a scenario that excludes events that directly open seats.

The batch also pairs each politics-first run with a run where the Ideas Workshop screenshot move is withheld. A finding requires more improved than worsened promotion outcomes in both scenarios, with a complete set of paired outcomes and a log entry for the move in a winning run. A promotion beats a miss. When both runs promote, an earlier month is an improvement. The report links both sides of the experiment. It gives a playtest question for cross-scenario findings and for gains within an individual scenario. This is a design signal for those seeds. Expected misses and design findings leave the batch passing. Adapter failures make it exit nonzero.

## Decision pacing

To reproduce a controlled stall from the gameBench root with Node.js 24.13 or later, run:

```powershell
npm.cmd ci && npm.cmd run --silent benchmark -- examples/pacing.json
```

Open the report. Dispatch to delivery confirmation takes three scripted steps in the baseline and five in the candidate. The candidate crosses the example threshold of four steps. Open the candidate log at the two line numbers under the stall, then run the same command with its `replay.json` to reproduce the result.

An optional manifest field, `pacing.stallAfterSteps`, enables pacing reports. Adapters can emit a `decision` event with a move ID and a strictly increasing positive step number. Set `meaningful: false` for forced decisions. Pacing compares consecutive meaningful decisions by move pair and occurrence within the same month and phase when provided and counts unmatched intervals separately. Each longest, changed, or stalled interval names the build and links to the surrounding log lines. The report records the scenario and seed. The Failureship strategy batch adds this section to each paired report with a five-step threshold. Its step count advances for every engine choice, including acknowledgements. Treat flagged intervals as playtest leads. They measure scripted steps rather than wall-clock response time.
