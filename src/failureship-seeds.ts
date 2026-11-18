import { z } from "zod";

export const seedSchema = z
  .int()
  .min(0)
  .max(2 ** 32 - 1);
export const seedListSchema = z
  .array(seedSchema)
  .min(1)
  .max(100)
  .refine(
    (seeds) => new Set(seeds).size === seeds.length,
    "Seeds must be distinct",
  );
