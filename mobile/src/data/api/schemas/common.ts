import { z } from "zod";

export const UUIDSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string();
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Ed25519AlgorithmSchema = z.literal("ed25519");

export type UUID = z.infer<typeof UUIDSchema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type IsoDate = z.infer<typeof IsoDateSchema>;
export type Ed25519Algorithm = z.infer<typeof Ed25519AlgorithmSchema>;
