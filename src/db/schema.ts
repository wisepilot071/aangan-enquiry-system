import { sql } from "drizzle-orm";
import {
  bigserial, boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("viewer"), // admin | operator | viewer
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("users_email_uq").on(t.email),
  check("users_role_ck", sql`${t.role} in ('admin','operator','viewer')`),
]);

export const enquiries = pgTable("enquiries", {
  id: uuid("id").primaryKey().defaultRandom(),
  seq: bigserial("seq", { mode: "number" }).notNull(),
  provider: text("provider").notNull(), // mock | vaani
  providerCallId: text("provider_call_id").notNull(),
  /** DEMO/MOCK records are excluded from production reporting. */
  isDemo: boolean("is_demo").notNull().default(false),
  channel: text("channel").notNull().default("phone"),
  /** inbound = a caller phoned the studio (the product). outbound = an operator-placed test call; never counted as an enquiry. */
  direction: text("direction").notNull().default("inbound"),
  callStatus: text("call_status").notNull().default("in_progress"), // in_progress|completed|missed|disconnected|failed
  callStartedAt: ts("call_started_at"),
  callEndedAt: ts("call_ended_at"),
  durationSec: integer("duration_sec"),
  /** First agent speech, as reported by the provider. NULL = not measurable. */
  firstResponseAt: ts("first_response_at"),
  qualifiedAt: ts("qualified_at"),
  notifiedAt: ts("notified_at"),
  recordCompletedAt: ts("record_completed_at"),
  callerName: text("caller_name"),
  callerPhone: text("caller_phone"), // from call metadata only
  callerType: text("caller_type").notNull().default("unknown"),
  projectCategory: text("project_category"),
  propertyType: text("property_type"),
  locationText: text("location_text"),
  carpetAreaSqft: integer("carpet_area_sqft"),
  facts: jsonb("facts").notNull().default({}),
  summary: text("summary"),
  transcript: jsonb("transcript"), // restricted: admin/operator only
  disposition: text("disposition"), // null until assessed
  priority: text("priority").notNull().default("normal"),
  needsHumanReview: boolean("needs_human_review").notNull().default(false),
  humanReviewReasons: jsonb("human_review_reasons").notNull().default([]),
  humanReviewStatus: text("human_review_status").notNull().default("none"), // none|open|resolved
  consultationStatus: text("consultation_status").notNull().default("none"), // none|requested|confirmed
  escalationKind: text("escalation_kind"),
  escalationRecipient: text("escalation_recipient"),
  conversionStatus: text("conversion_status").notNull().default("unknown"), // unknown|in_progress|converted|lost
  projectValueInr: numeric("project_value_inr", { precision: 14, scale: 0 }),
  previousEnquiryId: uuid("previous_enquiry_id"),
  ruleVersion: text("rule_version"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("enquiries_provider_call_uq").on(t.provider, t.providerCallId),
  index("enquiries_started_idx").on(t.callStartedAt),
  index("enquiries_disposition_idx").on(t.disposition),
  index("enquiries_phone_idx").on(t.callerPhone),
  index("enquiries_demo_idx").on(t.isDemo),
  check("enquiries_channel_ck", sql`${t.channel} = 'phone'`),
  check("enquiries_direction_ck", sql`${t.direction} in ('inbound','outbound')`),
  check("enquiries_status_ck", sql`${t.callStatus} in ('in_progress','completed','missed','disconnected','failed')`),
  check("enquiries_consult_ck", sql`${t.consultationStatus} in ('none','requested','confirmed')`),
  check("enquiries_conv_ck", sql`${t.conversionStatus} in ('unknown','in_progress','converted','lost')`),
]);

export const callEvents = pgTable("call_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  /** Provider event id, or sha256(body) when the provider supplies none. Deduplication key. */
  eventKey: text("event_key").notNull(),
  providerCallId: text("provider_call_id"),
  eventType: text("event_type").notNull(),
  occurredAt: ts("occurred_at"),
  receivedAt: ts("received_at").notNull().defaultNow(),
  status: text("status").notNull(), // processed|duplicate|rejected|failed|ignored
  enquiryId: uuid("enquiry_id").references(() => enquiries.id, { onDelete: "set null" }),
  errorCategory: text("error_category"),
  errorDetail: text("error_detail"), // sanitised, no payload content
  attempts: integer("attempts").notNull().default(1),
  isDemo: boolean("is_demo").notNull().default(false),
}, (t) => [
  uniqueIndex("call_events_key_uq").on(t.provider, t.eventKey),
  index("call_events_call_idx").on(t.providerCallId),
]);

export const qualificationAssessments = pgTable("qualification_assessments", {
  id: uuid("id").primaryKey().defaultRandom(),
  enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
  ruleVersion: text("rule_version").notNull(),
  disposition: text("disposition").notNull(),
  criteria: jsonb("criteria").notNull(),
  reasonCodes: jsonb("reason_codes").notNull().default([]),
  uncertainties: jsonb("uncertainties").notNull().default([]),
  nextQuestion: text("next_question"),
  assessedAt: ts("assessed_at").notNull().defaultNow(),
}, (t) => [index("assessments_enquiry_idx").on(t.enquiryId)]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
  destinationType: text("destination_type").notNull().default("telegram"),
  category: text("category").notNull(), // qualified_handoff | urgent_escalation | missed_call_followup
  /** Prevents duplicate handoffs: one row per (enquiry, category). */
  dedupeKey: text("dedupe_key").notNull(),
  /** pending | sent | failed | unavailable | mock_sent */
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  providerMessageId: text("provider_message_id"),
  errorCategory: text("error_category"),
  messagePreview: text("message_preview"),
  sentAt: ts("sent_at"),
  lastAttemptAt: ts("last_attempt_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  isDemo: boolean("is_demo").notNull().default(false),
}, (t) => [
  uniqueIndex("notifications_dedupe_uq").on(t.dedupeKey),
  index("notifications_enquiry_idx").on(t.enquiryId),
  check("notifications_status_ck", sql`${t.status} in ('pending','sent','failed','unavailable','mock_sent')`),
]);

export const costs = pgTable("costs", {
  id: uuid("id").primaryKey().defaultRandom(),
  enquiryId: uuid("enquiry_id").references(() => enquiries.id, { onDelete: "cascade" }),
  providerCallId: text("provider_call_id"),
  provider: text("provider").notNull(),
  category: text("category").notNull(), // voice_minutes | telephony | notification | other
  quantity: numeric("quantity", { precision: 14, scale: 4 }),
  unit: text("unit"),
  rateSource: text("rate_source").notNull(),
  rateValue: numeric("rate_value", { precision: 14, scale: 6 }),
  currency: text("currency").notNull().default("INR"),
  /** NULL means unknown. Never coerced to zero. */
  amount: numeric("amount", { precision: 14, scale: 4 }),
  basis: text("basis").notNull(), // actual | estimated | unknown
  calculatedAt: ts("calculated_at").notNull().defaultNow(),
  isDemo: boolean("is_demo").notNull().default(false),
}, (t) => [
  index("costs_enquiry_idx").on(t.enquiryId),
  uniqueIndex("costs_enquiry_cat_basis_uq").on(t.enquiryId, t.category, t.basis),
  check("costs_basis_ck", sql`${t.basis} in ('actual','estimated','unknown')`),
  check("costs_unknown_null_ck", sql`(${t.basis} = 'unknown') = (${t.amount} is null)`),
]);

export const followUpTasks = pgTable("follow_up_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // missed_call | human_requested | complaint | failed_handoff | frustrated_followup | dropped_call
  note: text("note"),
  status: text("status").notNull().default("open"), // open | done
  createdAt: ts("created_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
  completedBy: text("completed_by"),
  isDemo: boolean("is_demo").notNull().default(false),
}, (t) => [
  uniqueIndex("tasks_enquiry_kind_uq").on(t.enquiryId, t.kind),
  index("tasks_status_idx").on(t.status),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: ts("at").notNull().defaultNow(),
  actor: text("actor").notNull(), // user email | system | provider
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  detail: jsonb("detail").notNull().default({}),
}, (t) => [index("audit_entity_idx").on(t.entityType, t.entityId), index("audit_at_idx").on(t.at)]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
