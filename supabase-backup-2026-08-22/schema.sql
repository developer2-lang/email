


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_log       RECORD;
  v_total     INTEGER;
  v_delivered INTEGER;
BEGIN
  SELECT * INTO v_log FROM email_logs WHERE tracking_id = p_tracking_id LIMIT 1;
  IF v_log.id IS NULL THEN
    RETURN; -- unknown tracking id: nothing to record
  END IF;

  UPDATE email_logs
  SET clicked = true, clicked_at = NOW()
  WHERE id = v_log.id AND clicked = false;

  IF NOT FOUND THEN
    RETURN; -- duplicate click: already counted
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'sent')
    INTO v_total, v_delivered
  FROM email_logs
  WHERE campaign_id = v_log.campaign_id;

  INSERT INTO campaign_analytics
    (campaign_id, total_recipients, delivered, opened, clicked, open_rate, click_rate)
  VALUES (
    v_log.campaign_id, v_total, v_delivered, 0, 1,
    0,
    CASE WHEN v_delivered > 0 THEN ROUND((1::numeric / v_delivered) * 100, 1) ELSE 0 END
  )
  ON CONFLICT (campaign_id) DO UPDATE SET
    clicked          = campaign_analytics.clicked + 1,
    total_recipients = EXCLUDED.total_recipients,
    delivered        = EXCLUDED.delivered,
    click_rate       = CASE WHEN EXCLUDED.delivered > 0
                            THEN ROUND(((campaign_analytics.clicked + 1)::numeric / EXCLUDED.delivered) * 100, 1)
                            ELSE 0 END;
END;
$$;


ALTER FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_log       RECORD;
  v_total     INTEGER;
  v_delivered INTEGER;
BEGIN
  SELECT * INTO v_log FROM email_logs WHERE tracking_id = p_tracking_id LIMIT 1;
  IF v_log.id IS NULL THEN
    RETURN; -- unknown tracking id: nothing to record
  END IF;

  -- NOTE: no sent_at grace filter here. Gmail's image proxy / Outlook prefetch
  -- request each pixel URL exactly ONCE seconds after delivery and then serve
  -- the cached image to the human later, so that first request is the only
  -- chance to record the open. Counting the prefetch as an open is the
  -- industry standard (every ESP does it). A grace filter would silently lose
  -- every Gmail/Outlook open.

  UPDATE email_logs
  SET opened = true, opened_at = NOW()
  WHERE id = v_log.id AND opened = false;

  IF NOT FOUND THEN
    RETURN; -- duplicate open: already counted
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'sent')
    INTO v_total, v_delivered
  FROM email_logs
  WHERE campaign_id = v_log.campaign_id;

  INSERT INTO campaign_analytics
    (campaign_id, total_recipients, delivered, opened, clicked, open_rate, click_rate)
  VALUES (
    v_log.campaign_id, v_total, v_delivered, 1, 0,
    CASE WHEN v_delivered > 0 THEN ROUND((1::numeric / v_delivered) * 100, 1) ELSE 0 END,
    0
  )
  ON CONFLICT (campaign_id) DO UPDATE SET
    opened           = campaign_analytics.opened + 1,
    total_recipients = EXCLUDED.total_recipients,
    delivered        = EXCLUDED.delivered,
    open_rate        = CASE WHEN EXCLUDED.delivered > 0
                            THEN ROUND(((campaign_analytics.opened + 1)::numeric / EXCLUDED.delivered) * 100, 1)
                            ELSE 0 END;
END;
$$;


ALTER FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_email_logs_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_email_logs_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."audience_segments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "contact_type_id" "uuid",
    "company_category_id" "uuid",
    "is_all_contacts" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audience_segments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_analytics" (
    "campaign_id" "uuid" NOT NULL,
    "total_recipients" integer DEFAULT 0 NOT NULL,
    "delivered" integer DEFAULT 0 NOT NULL,
    "opened" integer DEFAULT 0 NOT NULL,
    "clicked" integer DEFAULT 0 NOT NULL,
    "open_rate" numeric(5,1) DEFAULT 0 NOT NULL,
    "click_rate" numeric(5,1) DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."campaign_analytics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_type" "text" DEFAULT 'application/octet-stream'::"text" NOT NULL,
    "file_size" bigint DEFAULT 0 NOT NULL,
    "storage_bucket" "text" DEFAULT 'campaign-attachments'::"text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."campaign_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid",
    "contact_id" "uuid",
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."campaign_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_followup_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "followup_campaign_id" "uuid" NOT NULL,
    "opened_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."campaign_followup_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_followups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "followup_campaign_id" "uuid" NOT NULL,
    "trigger_type" character varying(30) DEFAULT 'opened'::character varying NOT NULL,
    "followup_mode" character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_followup_mode" CHECK ((("followup_mode")::"text" = ANY ((ARRAY['automatic'::character varying, 'manual'::character varying])::"text"[]))),
    CONSTRAINT "chk_trigger_type" CHECK ((("trigger_type")::"text" = ANY ((ARRAY['opened'::character varying, 'clicked'::character varying, 'not_opened'::character varying])::"text"[])))
);


ALTER TABLE "public"."campaign_followups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "schedule_type" character varying(20) NOT NULL,
    "start_date" "date",
    "send_time" time without time zone,
    "repeat_interval" integer DEFAULT 1,
    "weekly_days" "text",
    "monthly_type" character varying(20),
    "day_of_month" integer,
    "week_number" character varying(10),
    "weekday" character varying(10),
    "timezone" character varying(50) DEFAULT 'Asia/Kolkata'::character varying,
    "next_run" timestamp without time zone,
    "last_run" timestamp without time zone,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_schedules_monthly_type_check" CHECK ((("monthly_type")::"text" = ANY ((ARRAY['day_of_month'::character varying, 'weekday'::character varying])::"text"[]))),
    CONSTRAINT "campaign_schedules_schedule_type_check" CHECK ((("schedule_type")::"text" = ANY ((ARRAY['one_time'::character varying, 'weekly'::character varying, 'monthly'::character varying])::"text"[]))),
    CONSTRAINT "campaign_schedules_week_number_check" CHECK ((("week_number")::"text" = ANY ((ARRAY['First'::character varying, 'Second'::character varying, 'Third'::character varying, 'Fourth'::character varying, 'Last'::character varying])::"text"[]))),
    CONSTRAINT "campaign_schedules_weekday_check" CHECK ((("weekday")::"text" = ANY ((ARRAY['Monday'::character varying, 'Tuesday'::character varying, 'Wednesday'::character varying, 'Thursday'::character varying, 'Friday'::character varying, 'Saturday'::character varying, 'Sunday'::character varying])::"text"[])))
);


ALTER TABLE "public"."campaign_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_name" "text" NOT NULL,
    "subject_line" "text" NOT NULL,
    "from_name" "text" NOT NULL,
    "audience_segment" "text",
    "campaign_type" "text",
    "schedule_date" "date",
    "schedule_time" time without time zone,
    "email_body" "text",
    "template_name" "text",
    "status" "text" DEFAULT 'Draft'::"text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "html_content" "text",
    "mailchimp_campaign_id" "text",
    "recipient_count" integer,
    "sent_at" timestamp with time zone,
    "scheduled_at" timestamp with time zone,
    "schedule_text" "text"
);


ALTER TABLE "public"."campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."company_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."company_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_types" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "company" "text" NOT NULL,
    "designation" "text",
    "industry" "text",
    "city" "text",
    "contact_type" "text",
    "company_category" "text",
    "notes" "text",
    "score" integer DEFAULT 0,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "email_opened" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid",
    "contact_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "retry_count" integer DEFAULT 0,
    "error_message" "text",
    "sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "last_attempt_at" timestamp with time zone,
    "next_retry_at" timestamp with time zone,
    "tracking_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "opened" boolean DEFAULT false,
    "opened_at" timestamp with time zone,
    "clicked" boolean DEFAULT false,
    "clicked_at" timestamp with time zone,
    CONSTRAINT "email_logs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."email_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."followup_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "followup_campaign_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "trigger_type" character varying(30) NOT NULL,
    "followup_mode" character varying(20) NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying,
    "opened_at" timestamp without time zone,
    "followup_sent_at" timestamp without time zone,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_followup_status" CHECK ((("status")::"text" = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'failed'::character varying])::"text"[]))),
    CONSTRAINT "chk_mode" CHECK ((("followup_mode")::"text" = ANY ((ARRAY['automatic'::character varying, 'manual'::character varying])::"text"[]))),
    CONSTRAINT "chk_trigger" CHECK ((("trigger_type")::"text" = ANY ((ARRAY['opened'::character varying, 'clicked'::character varying, 'not_opened'::character varying])::"text"[])))
);


ALTER TABLE "public"."followup_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mail_sequences" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sequence_name" "text",
    "sub1" "text",
    "body1" "text",
    "sub2" "text",
    "body2" "text",
    "sub3" "text",
    "body3" "text"
);


ALTER TABLE "public"."mail_sequences" OWNER TO "postgres";


ALTER TABLE "public"."mail_sequences" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."mail_sequences_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."sequence_branch_step_attachments" (
    "id" bigint NOT NULL,
    "branch_step_id" bigint NOT NULL,
    "file_name" "text" NOT NULL,
    "file_size" bigint,
    "storage_bucket" "text" DEFAULT 'sequence-attachments'::"text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sequence_branch_step_attachments" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sequence_branch_step_attachments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sequence_branch_step_attachments_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sequence_branch_step_attachments_id_seq" OWNED BY "public"."sequence_branch_step_attachments"."id";



CREATE TABLE IF NOT EXISTS "public"."sequence_branch_steps" (
    "id" bigint NOT NULL,
    "step" integer NOT NULL,
    "parent_step" integer,
    "parent_branch" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sequence_id" "uuid",
    "wait_hours" integer DEFAULT 0 NOT NULL,
    "parent_step_id" bigint,
    "send_action" "text" DEFAULT 'send_automatically'::"text" NOT NULL,
    "send_after_value" integer,
    "send_after_unit" "text",
    CONSTRAINT "sequence_branch_steps_parent_branch_check" CHECK (("parent_branch" = ANY (ARRAY['STARTING'::"text", 'OPENED'::"text", 'NOT_OPENED'::"text"]))),
    CONSTRAINT "sequence_branch_steps_send_action_check" CHECK (("send_action" = ANY (ARRAY['send_email'::"text", 'send_automatically'::"text", 'skip'::"text"]))),
    CONSTRAINT "sequence_branch_steps_send_after_unit_check" CHECK ((("send_after_unit" IS NULL) OR ("send_after_unit" = ANY (ARRAY['minutes'::"text", 'hours'::"text", 'days'::"text"]))))
);


ALTER TABLE "public"."sequence_branch_steps" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sequence_branch_steps_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sequence_branch_steps_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sequence_branch_steps_id_seq" OWNED BY "public"."sequence_branch_steps"."id";



CREATE TABLE IF NOT EXISTS "public"."sequence_enrollments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "current_step" integer DEFAULT 1 NOT NULL,
    "current_email_type" "text" DEFAULT 'normal'::"text" NOT NULL,
    "current_email_log_id" "uuid",
    "sent_at" timestamp with time zone,
    "next_run_at" timestamp with time zone,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "enrolled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_action_at" timestamp with time zone,
    "current_step_id" "uuid",
    CONSTRAINT "sequence_enrollments_current_email_type_check" CHECK (("current_email_type" = ANY (ARRAY['normal'::"text", 'increment'::"text"])))
);


ALTER TABLE "public"."sequence_enrollments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequence_step_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_step_id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_type" "text" DEFAULT 'application/octet-stream'::"text" NOT NULL,
    "file_size" bigint DEFAULT 0 NOT NULL,
    "storage_bucket" "text" DEFAULT 'sequence-attachments'::"text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sequence_step_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequence_step_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "sequence_step_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "email_log_id" "uuid",
    "sent_at" timestamp with time zone,
    "opened" boolean DEFAULT false NOT NULL,
    "opened_at" timestamp with time zone,
    "clicked" boolean DEFAULT false NOT NULL,
    "clicked_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "step_id" "uuid",
    CONSTRAINT "sequence_step_logs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."sequence_step_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequence_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "step_number" integer NOT NULL,
    "parent_step_id" "uuid",
    "parent_branch" "text" NOT NULL,
    "normal_subject" "text" NOT NULL,
    "normal_body" "text" NOT NULL,
    "from_name" "text",
    "wait_hours" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    "increment_subject" "text",
    "increment_body" "text",
    "recipient_type" "text" DEFAULT 'all'::"text" NOT NULL,
    "send_action" "text" DEFAULT 'send_automatically'::"text" NOT NULL,
    "send_after_value" integer,
    "send_after_unit" "text",
    CONSTRAINT "sequence_steps_parent_branch_check" CHECK (("parent_branch" = ANY (ARRAY['STARTING'::"text", 'OPENED'::"text", 'NOT_OPENED'::"text"]))),
    CONSTRAINT "sequence_steps_recipient_type_check" CHECK (("recipient_type" = ANY (ARRAY['all'::"text", 'opened'::"text", 'not_opened'::"text"]))),
    CONSTRAINT "sequence_steps_send_action_check" CHECK (("send_action" = ANY (ARRAY['send_email'::"text", 'send_automatically'::"text", 'skip'::"text"]))),
    CONSTRAINT "sequence_steps_send_after_unit_check" CHECK ((("send_after_unit" IS NULL) OR ("send_after_unit" = ANY (ARRAY['minutes'::"text", 'hours'::"text", 'days'::"text"]))))
);


ALTER TABLE "public"."sequence_steps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "starting_campaign_id" "uuid",
    "audience_segment" "text",
    "trigger_type" "text" DEFAULT 'behaviour'::"text" NOT NULL,
    "campaign_id" "uuid",
    "recipient_type" "text" DEFAULT 'all'::"text" NOT NULL,
    "send_mode" "text" DEFAULT 'both'::"text" NOT NULL,
    "subject_1" "text",
    "body_1" "text",
    "subject_2" "text",
    "body_2" "text",
    "subject_2a" "text",
    "body_2a" "text",
    "subject_3" "text",
    "body_3" "text",
    "subject_3a" "text",
    "body_3a" "text",
    "subject_4" "text",
    "body_4" "text",
    "subject_4a" "text",
    "body_4a" "text",
    "subject_5" "text",
    "body_5" "text",
    "subject_5a" "text",
    "body_5a" "text",
    "subject_6" "text",
    "body_6" "text",
    "subject_6a" "text",
    "body_6a" "text",
    "subject_7" "text",
    "body_7" "text",
    "subject_7a" "text",
    "body_7a" "text",
    "subject_8" "text",
    "body_8" "text",
    "subject_8a" "text",
    "body_8a" "text",
    "subject_9" "text",
    "body_9" "text",
    "subject_9a" "text",
    "body_9a" "text",
    "subject_10" "text",
    "body_10" "text",
    "subject_10a" "text",
    "body_10a" "text",
    "subject_11" "text",
    "body_11" "text",
    "subject_11a" "text",
    "body_11a" "text",
    "subject_12" "text",
    "body_12" "text",
    "subject_12a" "text",
    "body_12a" "text",
    CONSTRAINT "sequences_recipient_type_check" CHECK (("recipient_type" = ANY (ARRAY['all'::"text", 'opened'::"text", 'not_opened'::"text"]))),
    CONSTRAINT "sequences_send_mode_check" CHECK (("send_mode" = ANY (ARRAY['automatic'::"text", 'manual'::"text", 'both'::"text"]))),
    CONSTRAINT "sequences_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'paused'::"text", 'completed'::"text"]))),
    CONSTRAINT "sequences_trigger_type_check" CHECK (("trigger_type" = ANY (ARRAY['manual'::"text", 'time_based'::"text", 'behaviour'::"text"])))
);


ALTER TABLE "public"."sequences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text",
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "template_source" "text" DEFAULT 'database'::"text" NOT NULL,
    "storage_bucket" "text",
    "storage_path" "text"
);


ALTER TABLE "public"."templates" OWNER TO "postgres";


ALTER TABLE ONLY "public"."sequence_branch_step_attachments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sequence_branch_step_attachments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sequence_branch_steps" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sequence_branch_steps_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."audience_segments"
    ADD CONSTRAINT "audience_segments_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."audience_segments"
    ADD CONSTRAINT "audience_segments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_analytics"
    ADD CONSTRAINT "campaign_analytics_pkey" PRIMARY KEY ("campaign_id");



ALTER TABLE ONLY "public"."campaign_attachments"
    ADD CONSTRAINT "campaign_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_contacts"
    ADD CONSTRAINT "campaign_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_followup_logs"
    ADD CONSTRAINT "campaign_followup_logs_campaign_id_contact_id_followup_camp_key" UNIQUE ("campaign_id", "contact_id", "followup_campaign_id");



ALTER TABLE ONLY "public"."campaign_followup_logs"
    ADD CONSTRAINT "campaign_followup_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_followups"
    ADD CONSTRAINT "campaign_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_schedules"
    ADD CONSTRAINT "campaign_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_categories"
    ADD CONSTRAINT "company_categories_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."company_categories"
    ADD CONSTRAINT "company_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_types"
    ADD CONSTRAINT "contact_types_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."contact_types"
    ADD CONSTRAINT "contact_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_logs"
    ADD CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."followup_history"
    ADD CONSTRAINT "followup_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mail_sequences"
    ADD CONSTRAINT "mail_sequences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_branch_step_attachments"
    ADD CONSTRAINT "sequence_branch_step_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_branch_steps"
    ADD CONSTRAINT "sequence_branch_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_sequence_id_contact_id_key" UNIQUE ("sequence_id", "contact_id");



ALTER TABLE ONLY "public"."sequence_step_attachments"
    ADD CONSTRAINT "sequence_step_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_seq_step_contact_key" UNIQUE ("sequence_id", "sequence_step_id", "contact_id");



ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequences"
    ADD CONSTRAINT "sequences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_pkey" PRIMARY KEY ("id");



CREATE INDEX "campaign_attachments_campaign_idx" ON "public"."campaign_attachments" USING "btree" ("campaign_id");



CREATE INDEX "idx_email_logs_campaign" ON "public"."email_logs" USING "btree" ("campaign_id");



CREATE INDEX "idx_email_logs_clicked" ON "public"."email_logs" USING "btree" ("clicked");



CREATE INDEX "idx_email_logs_contact" ON "public"."email_logs" USING "btree" ("contact_id");



CREATE INDEX "idx_email_logs_opened" ON "public"."email_logs" USING "btree" ("opened");



CREATE INDEX "idx_email_logs_sent_at" ON "public"."email_logs" USING "btree" ("sent_at");



CREATE INDEX "idx_email_logs_status" ON "public"."email_logs" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_email_logs_tracking_id" ON "public"."email_logs" USING "btree" ("tracking_id");



CREATE INDEX "idx_followup_logs_campaign" ON "public"."campaign_followup_logs" USING "btree" ("campaign_id");



CREATE INDEX "idx_followup_logs_status" ON "public"."campaign_followup_logs" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_followups_campaign" ON "public"."campaign_followups" USING "btree" ("campaign_id");



CREATE INDEX "idx_sequence_branch_steps_parent" ON "public"."sequence_branch_steps" USING "btree" ("parent_step", "parent_branch");



CREATE INDEX "idx_sequence_branch_steps_parent_step_id" ON "public"."sequence_branch_steps" USING "btree" ("parent_step_id");



CREATE INDEX "idx_sequence_branch_steps_sequence_id" ON "public"."sequence_branch_steps" USING "btree" ("sequence_id");



CREATE INDEX "sequence_branch_step_attachments_step_idx" ON "public"."sequence_branch_step_attachments" USING "btree" ("branch_step_id");



CREATE INDEX "sequence_branch_steps_sequence_idx" ON "public"."sequence_branch_steps" USING "btree" ("sequence_id");



CREATE INDEX "sequence_enrollments_current_step_id_idx" ON "public"."sequence_enrollments" USING "btree" ("current_step_id");



CREATE INDEX "sequence_enrollments_next_run_at_idx" ON "public"."sequence_enrollments" USING "btree" ("next_run_at");



CREATE INDEX "sequence_enrollments_status_idx" ON "public"."sequence_enrollments" USING "btree" ("status");



CREATE INDEX "sequence_step_attachments_step_idx" ON "public"."sequence_step_attachments" USING "btree" ("sequence_step_id");



CREATE INDEX "sequence_step_logs_email_log_id_idx" ON "public"."sequence_step_logs" USING "btree" ("email_log_id");



CREATE INDEX "sequence_step_logs_step_id_idx" ON "public"."sequence_step_logs" USING "btree" ("step_id");



CREATE INDEX "sequence_steps_archived_idx" ON "public"."sequence_steps" USING "btree" ("sequence_id", "archived_at");



CREATE UNIQUE INDEX "sequence_steps_child_branch_unique" ON "public"."sequence_steps" USING "btree" ("sequence_id", "parent_step_id", "parent_branch") WHERE (("parent_step_id" IS NOT NULL) AND ("archived_at" IS NULL));



CREATE INDEX "sequences_campaign_id_idx" ON "public"."sequences" USING "btree" ("campaign_id");



CREATE INDEX "sequences_starting_campaign_id_idx" ON "public"."sequences" USING "btree" ("starting_campaign_id");



CREATE UNIQUE INDEX "uq_email_logs_tracking_id" ON "public"."email_logs" USING "btree" ("tracking_id");



CREATE OR REPLACE TRIGGER "trg_update_email_logs_updated_at" BEFORE UPDATE ON "public"."email_logs" FOR EACH ROW EXECUTE FUNCTION "public"."update_email_logs_updated_at"();



ALTER TABLE ONLY "public"."audience_segments"
    ADD CONSTRAINT "audience_segments_company_category_id_fkey" FOREIGN KEY ("company_category_id") REFERENCES "public"."company_categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."audience_segments"
    ADD CONSTRAINT "audience_segments_contact_type_id_fkey" FOREIGN KEY ("contact_type_id") REFERENCES "public"."contact_types"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."campaign_analytics"
    ADD CONSTRAINT "campaign_analytics_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_attachments"
    ADD CONSTRAINT "campaign_attachments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_contacts"
    ADD CONSTRAINT "campaign_contacts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_contacts"
    ADD CONSTRAINT "campaign_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_schedules"
    ADD CONSTRAINT "fk_campaign" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_followups"
    ADD CONSTRAINT "fk_campaign" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_logs"
    ADD CONSTRAINT "fk_email_logs_campaign" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_logs"
    ADD CONSTRAINT "fk_email_logs_contact" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_followups"
    ADD CONSTRAINT "fk_followup_campaign" FOREIGN KEY ("followup_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."followup_history"
    ADD CONSTRAINT "fk_history_campaign" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."followup_history"
    ADD CONSTRAINT "fk_history_contact" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."followup_history"
    ADD CONSTRAINT "fk_history_followup_campaign" FOREIGN KEY ("followup_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_branch_step_attachments"
    ADD CONSTRAINT "sequence_branch_step_attachments_branch_step_id_fkey" FOREIGN KEY ("branch_step_id") REFERENCES "public"."sequence_branch_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_branch_steps"
    ADD CONSTRAINT "sequence_branch_steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "public"."sequence_branch_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_attachments"
    ADD CONSTRAINT "sequence_step_attachments_sequence_step_id_fkey" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_email_log_id_fkey" FOREIGN KEY ("email_log_id") REFERENCES "public"."email_logs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequences"
    ADD CONSTRAINT "sequences_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sequences"
    ADD CONSTRAINT "sequences_starting_campaign_id_fkey" FOREIGN KEY ("starting_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE SET NULL;



CREATE POLICY "campaign attachments delete" ON "public"."campaign_attachments" FOR DELETE TO "anon" USING (true);



CREATE POLICY "campaign attachments insert" ON "public"."campaign_attachments" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "campaign attachments select" ON "public"."campaign_attachments" FOR SELECT TO "anon" USING (true);



ALTER TABLE "public"."campaign_attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mail_sequences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sequence attachments delete" ON "public"."sequence_step_attachments" FOR DELETE TO "anon" USING (true);



CREATE POLICY "sequence attachments insert" ON "public"."sequence_step_attachments" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "sequence attachments select" ON "public"."sequence_step_attachments" FOR SELECT TO "anon" USING (true);



CREATE POLICY "sequence branch attachments delete" ON "public"."sequence_branch_step_attachments" FOR DELETE TO "anon" USING (true);



CREATE POLICY "sequence branch attachments insert" ON "public"."sequence_branch_step_attachments" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "sequence branch attachments select" ON "public"."sequence_branch_step_attachments" FOR SELECT TO "anon" USING (true);



ALTER TABLE "public"."sequence_branch_step_attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sequence_step_attachments" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";














































































































































































GRANT ALL ON FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_email_logs_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_email_logs_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_email_logs_updated_at"() TO "service_role";
























GRANT ALL ON TABLE "public"."audience_segments" TO "anon";
GRANT ALL ON TABLE "public"."audience_segments" TO "authenticated";
GRANT ALL ON TABLE "public"."audience_segments" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_analytics" TO "anon";
GRANT ALL ON TABLE "public"."campaign_analytics" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_analytics" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_attachments" TO "anon";
GRANT ALL ON TABLE "public"."campaign_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_contacts" TO "anon";
GRANT ALL ON TABLE "public"."campaign_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_followup_logs" TO "anon";
GRANT ALL ON TABLE "public"."campaign_followup_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_followup_logs" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_followups" TO "anon";
GRANT ALL ON TABLE "public"."campaign_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_followups" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_schedules" TO "anon";
GRANT ALL ON TABLE "public"."campaign_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."campaigns" TO "anon";
GRANT ALL ON TABLE "public"."campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."company_categories" TO "anon";
GRANT ALL ON TABLE "public"."company_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."company_categories" TO "service_role";



GRANT ALL ON TABLE "public"."contact_types" TO "anon";
GRANT ALL ON TABLE "public"."contact_types" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_types" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT ALL ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT ALL ON TABLE "public"."email_logs" TO "anon";
GRANT ALL ON TABLE "public"."email_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."email_logs" TO "service_role";



GRANT ALL ON TABLE "public"."followup_history" TO "anon";
GRANT ALL ON TABLE "public"."followup_history" TO "authenticated";
GRANT ALL ON TABLE "public"."followup_history" TO "service_role";



GRANT ALL ON TABLE "public"."mail_sequences" TO "anon";
GRANT ALL ON TABLE "public"."mail_sequences" TO "authenticated";
GRANT ALL ON TABLE "public"."mail_sequences" TO "service_role";



GRANT ALL ON SEQUENCE "public"."mail_sequences_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."mail_sequences_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."mail_sequences_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_branch_step_attachments" TO "anon";
GRANT ALL ON TABLE "public"."sequence_branch_step_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_branch_step_attachments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sequence_branch_step_attachments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sequence_branch_step_attachments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sequence_branch_step_attachments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_branch_steps" TO "anon";
GRANT ALL ON TABLE "public"."sequence_branch_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_branch_steps" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sequence_branch_steps_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sequence_branch_steps_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sequence_branch_steps_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_enrollments" TO "anon";
GRANT ALL ON TABLE "public"."sequence_enrollments" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_enrollments" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_step_attachments" TO "anon";
GRANT ALL ON TABLE "public"."sequence_step_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_step_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_step_logs" TO "anon";
GRANT ALL ON TABLE "public"."sequence_step_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_step_logs" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_steps" TO "anon";
GRANT ALL ON TABLE "public"."sequence_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_steps" TO "service_role";



GRANT ALL ON TABLE "public"."sequences" TO "anon";
GRANT ALL ON TABLE "public"."sequences" TO "authenticated";
GRANT ALL ON TABLE "public"."sequences" TO "service_role";



GRANT ALL ON TABLE "public"."templates" TO "anon";
GRANT ALL ON TABLE "public"."templates" TO "authenticated";
GRANT ALL ON TABLE "public"."templates" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































