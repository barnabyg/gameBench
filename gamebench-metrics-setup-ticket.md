# Publish game metrics for gameBench

Publish a machine-readable report that gameBench can fetch from GitHub. Start with at least one measurement the game can make reliably, such as goal completion rate, turns between decisions, layout issue count, or startup time.

## Implementation

1. **Add a metrics generation command.** Use `npm run metrics` for npm projects. For other projects, use the repository’s usual task runner and document the command. Reuse existing tests, simulations, and measurement code where possible. Write `metrics.json` at the repository root using the format below. Document what each metric measures and the conditions needed to reproduce it, such as the scenario, seeds, strategy, viewport, or run limit.
2. **Add `gamebench.json` at the repository root.** gameBench will read this file from the default branch to discover how the repo publishes its report.

   ```json
   {
     "schemaVersion": 1,
     "workflow": ".github/workflows/gamebench-metrics.yml",
     "artifact": "gamebench-metrics"
   }
   ```

3. **Add the GitHub Actions workflow.** Name it **Generate gameBench metrics** and enable manual runs with `workflow_dispatch`. Check out the selected revision, set up the project using its usual CI steps, run the metrics command, and upload `metrics.json` as the `gamebench-metrics` artifact. Publish the artifact only after successful generation. Keep the generated report out of Git.

## Report format

The example shows two measurements from a balance suite. Choose the suites and metrics that fit the game.

```json
{
  "schemaVersion": 1,
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "generatedAt": "2026-11-18T14:00:00Z",
  "suites": [
    {
      "id": "scenario-balance",
      "version": 1,
      "area": "balance",
      "metrics": [
        {
          "id": "strategy-a.goal-completion",
          "label": "Strategy A goal completion",
          "value": 75,
          "unit": "percent",
          "sampleSize": 100
        },
        {
          "id": "strategy-a.median-goal-turn",
          "label": "Strategy A median goal turn",
          "value": 18,
          "unit": "turns",
          "sampleSize": 75
        }
      ]
    }
  ]
}
```

- `commit` is the full Git SHA actually tested. `generatedAt` is a UTC timestamp.
- Use stable suite and metric IDs. Each suite has an `area` of `balance`, `pacing`, `visuals`, or `stability`. Use `stability` for performance measurements such as startup time.
- Give each metric a readable `label`, a numeric `value`, a `unit`, and a `sampleSize` counting the observations used to calculate the value. Report percentages on a 0–100 scale. Use `value: null` and `sampleSize: 0` when there are no eligible observations. For example, a strategy that fails all 100 attempts has a completion rate of `0` from `100` attempts and a median goal turn of `null` from `0` successes.
- Increment the suite `version` when the scenarios, sample selection, or measurement method change enough to make previous results unsuitable for direct comparison. Ordinary game tuning keeps the same suite version.

## Acceptance criteria

- The repository documents one command to prepare and run metrics generation from a clean checkout. It produces a valid report with the tested SHA and at least one measured value.
- Two runs on the same revision produce the same suite and metric IDs, versions, units, and sample sizes. Deterministic values match exactly. For measurements that naturally vary, such as timings, document the execution conditions and expected variation.
- Results agree with the underlying measurement for the same inputs. When a metric has no eligible observations, the report represents that case correctly.
- After the setup lands on the default branch, manually run **Generate gameBench metrics** in GitHub. The successful run has a downloadable `gamebench-metrics` artifact containing `metrics.json` for the selected revision.
- Include the successful workflow run URL in the handoff so the published report can be verified.
