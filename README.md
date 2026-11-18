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

A comparison manifest names a trusted local Node adapter and two builds, each with a version and path. Paths resolve relative to the manifest. The runner starts the adapter in a fresh Node process once per build and supplies one JSON object on standard input with the absolute `build` path and the shared `inputs` object. The adapter writes one JSON gameplay event per line to standard output and finishes a successful scenario with a milestone event carrying a non-negative integer `turn`. Send diagnostics to standard error and exit nonzero on failure. The example manifests and adapter form a runnable reference.

## Verification

Run `npm.cmd run verify` from the repository root. It checks formatting, lint (including secret detection), strict types, command-level tests, dependency advisories and the npm package contents. TypeScript executes directly on Node, so there is no compilation or bundling step.

## Failureship first-promotion check

From the gameBench root, with dependencies installed, Chromium provisioned by `npx.cmd playwright install chromium`, and two Failureship builds produced with `npm.cmd run build -- --mode e2e` in their respective checkouts, run:

```powershell
npm.cmd run failureship:smoke -- C:/builds/baseline/dist BASELINE_SHA C:/builds/candidate/dist CANDIDATE_SHA 1280 800
```

Replace the example paths and version identifiers with your builds. The last two arguments are the viewport width and height in pixels. The check opens a fresh browser for each build, starts seed 2 at month 7 using the game's E2E setup, and plays through the promotion decision. Expect the Team lead notice in both screenshots linked by the report. The command exits nonzero if the required outcome fails. The evidence directory includes the replay manifest, action logs, and a screenshot of the failed browser state when it can be captured.

Pull requests run this same command against two pinned Failureship commits. Download the `failureship-first-promotion` artifact from the check to inspect its evidence.

## Incomplete comparisons

If either build exits early or misses the milestone, the runner still attempts both builds and prints the report path before returning a nonzero exit code. The report includes the scenario and seed, both builds' statuses and logs, and counts of attempted, reached, and missing milestones. A missing milestone has a null turn count, and the comparison has a null turn difference.
