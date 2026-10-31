import { z } from "zod";
import { EVENT_CATEGORIES, RULE_MATCHES, SEVERITIES } from "./types";

const ruleIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, hyphens or underscores");

const endpointSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === "*" || (value.startsWith("/") && !value.startsWith("//")), {
    message: "Endpoint must be '*' or an absolute path starting with a single '/'",
  })
  .refine((value) => !value.includes("..") && !value.includes("\\"), {
    message: "Endpoint must not contain path traversal characters",
  })
  // eslint-disable-next-line no-control-regex -- whitespace and control characters must be rejected
  .refine((value) => !/[\u0000-\u001f\u007f\s]/.test(value), {
    message: "Endpoint must not contain whitespace or control characters",
  });

const ruleFields = {
  name: z.string().trim().min(2).max(80),
  endpoint: endpointSchema,
  match: z.enum(RULE_MATCHES),
  limit: z.number().int().min(1).max(100_000),
  windowSeconds: z.number().int().min(1).max(3_600),
  burst: z.number().int().min(0).max(100_000),
  enabled: z.boolean(),
};

export const rateLimitRulePatchSchema = z
  .object({
    name: ruleFields.name.optional(),
    endpoint: ruleFields.endpoint.optional(),
    match: ruleFields.match.optional(),
    limit: ruleFields.limit.optional(),
    windowSeconds: ruleFields.windowSeconds.optional(),
    burst: ruleFields.burst.optional(),
    enabled: ruleFields.enabled.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const rateLimitRuleCreateSchema = z
  .object({
    id: ruleIdSchema,
    ...ruleFields,
  })
  .strict();

export const detectionSettingsSchema = z
  .object({
    enabled: z.boolean(),
    windowSeconds: z.number().int().min(5).max(300),
    clientRpsThreshold: z.number().min(0.1).max(10_000),
    endpointRpsThreshold: z.number().min(0.1).max(100_000),
    trafficSpikeMultiplier: z.number().min(1.1).max(100),
    trafficSpikeMinRps: z.number().min(1).max(100_000),
    violationThreshold: z.number().int().min(1).max(10_000),
    violationWindowSeconds: z.number().int().min(5).max(3_600),
    upstreamErrorRateThreshold: z.number().min(0.01).max(1),
    upstreamMinSamples: z.number().int().min(1).max(100_000),
    cooldownAbuseThreshold: z.number().int().min(1).max(100_000),
    autoIsolate: z.boolean(),
    isolationSeconds: z.number().int().min(5).max(86_400),
    suppressionSeconds: z.number().int().min(1).max(3_600),
  })
  .strict();

export const settingsUpdateSchema = z
  .object({
    detection: detectionSettingsSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(8).max(200),
  })
  .strict();

export const eventsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    severity: z.enum(SEVERITIES).optional(),
    category: z.enum(EVENT_CATEGORIES).optional(),
    clientId: z.string().max(64).optional(),
    endpoint: z.string().max(200).optional(),
    q: z.string().trim().max(120).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const trafficQuerySchema = z
  .object({
    windowMinutes: z.coerce.number().int().min(1).max(360).default(15),
  })
  .strict();

export const clientsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    windowMinutes: z.coerce.number().int().min(1).max(1_440).default(60),
  })
  .strict();

export type RulePatchInput = z.infer<typeof rateLimitRulePatchSchema>;
export type RuleCreateInput = z.infer<typeof rateLimitRuleCreateSchema>;
export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;
export type EventsQueryInput = z.infer<typeof eventsQuerySchema>;
export type TrafficQueryInput = z.infer<typeof trafficQuerySchema>;
export type ClientsQueryInput = z.infer<typeof clientsQuerySchema>;

export { ruleIdSchema };
