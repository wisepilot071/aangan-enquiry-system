CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"provider_call_id" text,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"enquiry_id" uuid,
	"error_category" text,
	"error_detail" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid,
	"provider_call_id" text,
	"provider" text NOT NULL,
	"category" text NOT NULL,
	"quantity" numeric(14, 4),
	"unit" text,
	"rate_source" text NOT NULL,
	"rate_value" numeric(14, 6),
	"currency" text DEFAULT 'INR' NOT NULL,
	"amount" numeric(14, 4),
	"basis" text NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "costs_basis_ck" CHECK ("costs"."basis" in ('actual','estimated','unknown')),
	CONSTRAINT "costs_unknown_null_ck" CHECK (("costs"."basis" = 'unknown') = ("costs"."amount" is null))
);
--> statement-breakpoint
CREATE TABLE "enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"provider" text NOT NULL,
	"provider_call_id" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"channel" text DEFAULT 'phone' NOT NULL,
	"call_status" text DEFAULT 'in_progress' NOT NULL,
	"call_started_at" timestamp with time zone,
	"call_ended_at" timestamp with time zone,
	"duration_sec" integer,
	"first_response_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"record_completed_at" timestamp with time zone,
	"caller_name" text,
	"caller_phone" text,
	"caller_type" text DEFAULT 'unknown' NOT NULL,
	"project_category" text,
	"property_type" text,
	"location_text" text,
	"carpet_area_sqft" integer,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text,
	"transcript" jsonb,
	"disposition" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"needs_human_review" boolean DEFAULT false NOT NULL,
	"human_review_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"human_review_status" text DEFAULT 'none' NOT NULL,
	"consultation_status" text DEFAULT 'none' NOT NULL,
	"escalation_kind" text,
	"escalation_recipient" text,
	"conversion_status" text DEFAULT 'unknown' NOT NULL,
	"project_value_inr" numeric(14, 0),
	"previous_enquiry_id" uuid,
	"rule_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enquiries_channel_ck" CHECK ("enquiries"."channel" = 'phone'),
	CONSTRAINT "enquiries_status_ck" CHECK ("enquiries"."call_status" in ('in_progress','completed','missed','disconnected','failed')),
	CONSTRAINT "enquiries_consult_ck" CHECK ("enquiries"."consultation_status" in ('none','requested','confirmed')),
	CONSTRAINT "enquiries_conv_ck" CHECK ("enquiries"."conversion_status" in ('unknown','in_progress','converted','lost'))
);
--> statement-breakpoint
CREATE TABLE "follow_up_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"destination_type" text DEFAULT 'telegram' NOT NULL,
	"category" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"error_category" text,
	"message_preview" text,
	"sent_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "notifications_status_ck" CHECK ("notifications"."status" in ('pending','sent','failed','unavailable','mock_sent'))
);
--> statement-breakpoint
CREATE TABLE "qualification_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"rule_version" text NOT NULL,
	"disposition" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uncertainties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_question" text,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_ck" CHECK ("users"."role" in ('admin','operator','viewer'))
);
--> statement-breakpoint
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costs" ADD CONSTRAINT "costs_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_assessments" ADD CONSTRAINT "qualification_assessments_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "call_events_key_uq" ON "call_events" USING btree ("provider","event_key");--> statement-breakpoint
CREATE INDEX "call_events_call_idx" ON "call_events" USING btree ("provider_call_id");--> statement-breakpoint
CREATE INDEX "costs_enquiry_idx" ON "costs" USING btree ("enquiry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "costs_enquiry_cat_basis_uq" ON "costs" USING btree ("enquiry_id","category","basis");--> statement-breakpoint
CREATE UNIQUE INDEX "enquiries_provider_call_uq" ON "enquiries" USING btree ("provider","provider_call_id");--> statement-breakpoint
CREATE INDEX "enquiries_started_idx" ON "enquiries" USING btree ("call_started_at");--> statement-breakpoint
CREATE INDEX "enquiries_disposition_idx" ON "enquiries" USING btree ("disposition");--> statement-breakpoint
CREATE INDEX "enquiries_phone_idx" ON "enquiries" USING btree ("caller_phone");--> statement-breakpoint
CREATE INDEX "enquiries_demo_idx" ON "enquiries" USING btree ("is_demo");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_enquiry_kind_uq" ON "follow_up_tasks" USING btree ("enquiry_id","kind");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "follow_up_tasks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_enquiry_idx" ON "notifications" USING btree ("enquiry_id");--> statement-breakpoint
CREATE INDEX "assessments_enquiry_idx" ON "qualification_assessments" USING btree ("enquiry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");