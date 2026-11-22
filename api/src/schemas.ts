// FILE: api/src/schemas.ts
// Runtime validation schemas for API request bodies.
import { z } from "zod";

// Intelligence categories are configuration: adding a value here makes it available for monitored pages.
export const INTELLIGENCE_CATEGORIES = ["marketing", "product"] as const;
export type IntelligenceCategory = (typeof INTELLIGENCE_CATEGORIES)[number];

export const loginRequestSchema = z.strictObject({
  accessKey: z.string().min(1).max(256),
});

// Accepts http and https addresses without embedded credentials and removes the fragment.
// Destination safety checks (private ranges, redirects) are added with the collection engine.
const webUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .transform((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Enter a valid URL." });
      return z.NEVER;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Only http and https URLs are allowed.",
      });
      return z.NEVER;
    }
    if (parsed.username !== "" || parsed.password !== "") {
      context.addIssue({
        code: "custom",
        message: "URLs with embedded credentials are not allowed.",
      });
      return z.NEVER;
    }
    parsed.hash = "";
    return parsed.toString();
  });

const atLeastOneField = (value: object) => Object.keys(value).length > 0;
const atLeastOneFieldMessage = { message: "At least one field is required." };

export const createCompetitorSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  websiteUrl: webUrlSchema.nullable().optional(),
  notes: z.string().trim().max(5000).optional(),
});

export const updateCompetitorSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    websiteUrl: webUrlSchema.nullable(),
    notes: z.string().trim().max(5000),
    isActive: z.boolean(),
  })
  .partial()
  .refine(atLeastOneField, atLeastOneFieldMessage);

export const createPageSchema = z.strictObject({
  url: webUrlSchema,
  label: z.string().trim().max(200).optional(),
  category: z.enum(INTELLIGENCE_CATEGORIES),
  checkIntervalHours: z.number().int().min(1).max(720).optional(),
});

// The URL is fixed once a page exists; a different address is a different page.
export const updatePageSchema = z
  .strictObject({
    label: z.string().trim().max(200),
    category: z.enum(INTELLIGENCE_CATEGORIES),
    checkIntervalHours: z.number().int().min(1).max(720),
    isActive: z.boolean(),
  })
  .partial()
  .refine(atLeastOneField, atLeastOneFieldMessage);

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type CreateCompetitorInput = z.infer<typeof createCompetitorSchema>;
export type UpdateCompetitorInput = z.infer<typeof updateCompetitorSchema>;
export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
