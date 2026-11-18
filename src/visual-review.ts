import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { z } from "zod";
import {
  checkpoints as ids,
  checkpointFile,
  type Checkpoint,
} from "./visual-checkpoints.ts";

export const visualReviewSchema = z.object({
  width: z.int().min(1).max(4096),
  height: z.int().min(1).max(4096),
  changedPixelRatio: z.number().gt(0).lte(1),
});
const checkpoints = [
  { checkpoint: ids.ground, label: "Ground floor" },
  { checkpoint: ids.promotion, label: "First promotion" },
  { checkpoint: ids.penthouse, label: "Penthouse" },
  { checkpoint: ids.top, label: "Floor 3, highest playable floor" },
] as const;
const roles = ["baseline", "candidate"] as const;

export async function reviewVisuals(
  directory: string,
  settings: z.infer<typeof visualReviewSchema>,
  versions: Record<(typeof roles)[number], string>,
) {
  const { width, height, changedPixelRatio } = settings;
  const resolution = { width, height };
  async function capture(role: (typeof roles)[number], checkpoint: Checkpoint) {
    const screenshot = path.join(role, checkpointFile(checkpoint));
    const version = versions[role];
    try {
      const bytes = await readFile(path.join(directory, screenshot));
      const image = PNG.sync.read(bytes);
      if (image.width !== width || image.height !== height)
        return {
          evidence: {
            version,
            status: "invalid",
            screenshot,
            actualResolution: { width: image.width, height: image.height },
            reason: "Capture does not match the requested resolution",
          },
        };
      return { image, evidence: { version, status: "captured", screenshot } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          evidence: {
            version,
            status: "missing",
            reason:
              checkpoint === ids.penthouse
                ? "No playable penthouse capture. See Floor 3 if available."
                : "No screenshot was captured. See the build log.",
          },
        };
      }
      return {
        evidence: {
          version,
          status: "invalid",
          screenshot,
          reason: "Capture could not be read as a PNG",
        },
      };
    }
  }
  const rows = [];
  for (const { checkpoint, label } of checkpoints) {
    const baseline = await capture("baseline", checkpoint);
    const candidate = await capture("candidate", checkpoint);
    const row = {
      checkpoint,
      label,
      resolution,
      baseline: baseline.evidence,
      candidate: candidate.evidence,
    };
    if (!baseline.image || !candidate.image) {
      rows.push({ ...row, status: "missing" });
      continue;
    }
    const diff = new PNG({ width, height });
    const changedPixels = pixelmatch(
      baseline.image.data,
      candidate.image.data,
      diff.data,
      width,
      height,
      { threshold: 0.1 },
    );
    const ratio = changedPixels / (width * height);
    const changed = ratio >= changedPixelRatio;
    const diffName = `${checkpoint}-diff.png`;
    if (changed)
      await writeFile(path.join(directory, diffName), PNG.sync.write(diff));
    rows.push({
      ...row,
      status: changed ? "changed" : "matched",
      changedPixels,
      changedPixelRatio: ratio,
      ...(changed ? { diff: diffName } : {}),
    });
  }
  return {
    changedPixelThreshold: changedPixelRatio,
    checkpoints: rows,
    questions: [
      "At this resolution, is the promotion text legible and can you tell why the seat was awarded?",
      "Does the building look posher from the ground floor to Floor 3? Which visible details give you that impression?",
      "For flagged pairs, which visual changes were expected and which need another look?",
    ],
  };
}
