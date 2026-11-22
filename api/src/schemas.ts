// FILE: api/src/schemas.ts
// Runtime validation schemas for API request bodies.
import { z } from "zod";

export const loginRequestSchema = z.strictObject({
  accessKey: z.string().min(1).max(256),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
