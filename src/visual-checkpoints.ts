export const checkpoints = {
  ground: "ground-floor",
  promotion: "promotion",
  penthouse: "penthouse",
  top: "top-floor",
} as const;
export type Checkpoint = (typeof checkpoints)[keyof typeof checkpoints];

export function checkpointFile(checkpoint: Checkpoint) {
  return `${checkpoint}.png`;
}
