import { z } from "zod";

export const InstallerTargetSchema = z.enum([
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
]);

export type InstallerTarget = z.infer<typeof InstallerTargetSchema>;
