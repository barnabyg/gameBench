# Game Build Benchmark

## Purpose

Give developers a repeatable way to see what improved or regressed between builds. Use the benchmark to spot unintended changes in balance, pacing, visuals, and stability, and to give playtesters specific questions to investigate.

## How it works

A shared runner compares a candidate build with a designated baseline. Each game supplies an adapter that can launch the build, load known scenarios, run scripted player strategies, and capture gameplay events and screenshots. Both builds run with the same scenarios, settings, and random seeds. Record the build versions and seeds so findings can be reproduced.

| Area | What to measure |
| --- | --- |
| Balance | Success rates and time to milestones by strategy. Flag moves that dominate across scenarios where the design calls for meaningful trade-offs. |
| Pacing | Time between meaningful decisions and points where progression stalls. |
| Visuals | Clipped text, overlapping UI, and unexpected changes in matched screenshots. A human or vision model can also review legibility and fit with the intended art direction. |
| Performance and stability | Crashes, load times, frame-time spikes, and whether a save can be reloaded successfully. |
| Player experience | Short human playtests to see whether players understand outcomes and find the choices engaging. |

## Pilot with Failureship

- **Gameplay.** Run three scripted players across the same seeds. One prioritises delivery, one prioritises office politics, and one adapts to the situation. Compare promotion rates, time to promotion, and the decisions that drive each outcome. Office politics outperforming delivery may support the satire. A single move that wins in almost every situation would be worth investigating.
- **Visuals.** Capture the ground floor, a promotion screen, and the penthouse at fixed resolutions. Check layout and legibility, then review whether the building visibly gets posher as the player climbs.
- **Build check.** Automate one short scenario that launches the game and reaches the first promotion screen. Keep this check and reliable layout checks fast enough for pull requests. Run larger simulation batches separately.

## Output

Produce a short report showing what changed, how large the change was, and where to find the screenshots or logs needed to reproduce it. For example, “The politics-first strategy reached the penthouse in half as many turns, and the promotion screen now clips at 1280×720.” Use repeatable failures as build gates and surface design judgements for review.
