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
