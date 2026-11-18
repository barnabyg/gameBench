# Publish Mars Mission balance metrics for gameBench

Mars Mission already runs seeded balance simulations and reports how often each strategy reaches its goal. Expose those results as a machine-readable report that gameBench can fetch from GitHub.

## Implementation

1. **Add `npm run metrics`.** Reuse the simulation and structured results behind `npm run balance`. Keep the existing human-readable report working. Write `metrics.json` at the repository root using the format below. For each existing strategy with a defined goal, report the goal completion rate and the median turn among successful runs. Use a fixed, documented seed set and turn limit.
2. **Add `gamebench.json` at the repository root.** gameBench will read this file from the default branch to discover how the repo publishes its report.

   ```json
   {
     "schemaVersion": 1,
     "workflow": ".github/workflows/gamebench-metrics.yml",
     "artifact": "gamebench-metrics"
   }
   ```

3. **Add the GitHub Actions workflow.** Name it **Generate gameBench metrics** and enable manual runs with `workflow_dispatch`. Check out the selected revision, install dependencies with `npm ci`, run `npm run metrics`, and upload `metrics.json` as the `gamebench-metrics` artifact. Publish the artifact only after successful generation. Keep the generated report out of Git.

## Report format

The values below are illustrative. Use stable metric IDs based on the strategy and measurement.

```json
{
  "schemaVersion": 1,
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "generatedAt": "2026-11-18T14:00:00Z",
  "suites": [
    {
      "id": "mars-mission-balance",
      "version": 1,
      "area": "balance",
      "metrics": [
        {
          "id": "crew-at-base.goal-completion",
          "label": "Crew at a Base goal completion",
          "value": 75,
          "unit": "percent",
          "sampleSize": 100
        },
        {
          "id": "crew-at-base.median-goal-turn",
          "label": "Crew at a Base median goal turn",
          "value": 18,
          "unit": "turns",
          "sampleSize": 75
        }
      ]
    }
  ]
}
```

`commit` is the full SHA actually tested. `generatedAt` is a UTC timestamp. Completion rates use a 0–100 scale and count all attempts. Median goal turn counts successful attempts only. If none succeed, record `value: null` and `sampleSize: 0` for the median. Increment the suite `version` when a change to the seeds, turn limit, strategy behaviour, goal definition, or calculation makes results unsuitable for direct comparison. Ordinary game tuning keeps the same suite version.

## Acceptance criteria

- After `npm ci`, `npm run metrics` from the Mars Mission root produces a valid report with the tested SHA. Running it twice on the same revision produces the same metric IDs, values, and sample sizes.
- The reported completion rates and median turns agree with the existing balance calculation for the same strategies and inputs. Zero successful runs are represented correctly.
- After the setup lands on the default branch, manually run **Generate gameBench metrics** in GitHub. The successful run has a downloadable `gamebench-metrics` artifact containing `metrics.json` for the selected revision.
- Include the successful workflow run URL in the handoff so it can serve as gameBench’s first integration example.
