-- Amai initial schema. Mirrors prisma/schema.prisma (Prisma naming conventions).
CREATE EXTENSION IF NOT EXISTS citext;

-- Enums
CREATE TYPE "message_type" AS ENUM ('text','image','video','audio','voice','document','location','live_location','contact','sticker','gif','link','status_reply','call_event');
CREATE TYPE "attachment_kind" AS ENUM ('image','video','audio','voice','document','sticker','status_media','avatar','call_recording');
CREATE TYPE "status_kind" AS ENUM ('photo','video','text');
CREATE TYPE "call_type" AS ENUM ('voice','video');
CREATE TYPE "call_state" AS ENUM ('ringing','accepted','rejected','missed','ended','failed','cancelled');
CREATE TYPE "notification_preview" AS ENUM ('full','sender_only','hidden');

CREATE SEQUENCE "message_sync_seq" AS BIGINT START 1;

-- Accounts
CREATE TABLE "authorized_accounts" (
  "id" UUID NOT NULL,
  "slot" SMALLINT NOT NULL,
  "email" CITEXT NOT NULL,
  "setup_token_hash" TEXT,
  "setup_token_expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "authorized_accounts_pkey" PRIMARY KEY ("id"),
  -- Hard two-account limit: only slots 1 and 2 may exist.
  CONSTRAINT "authorized_accounts_slot_check" CHECK ("slot" IN (1, 2))
);
CREATE UNIQUE INDEX "authorized_accounts_slot_key" ON "authorized_accounts"("slot");
CREATE UNIQUE INDEX "authorized_accounts_email_key" ON "authorized_accounts"("email");

CREATE TABLE "users" (
  "id" UUID NOT NULL,
  "authorized_account_id" UUID NOT NULL,
  "email" CITEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "display_name" VARCHAR(60) NOT NULL,
  "about" VARCHAR(280) NOT NULL DEFAULT '',
  "avatar_object_key" TEXT,
  "last_seen_at" TIMESTAMPTZ(6),
  "failed_login_count" INTEGER NOT NULL DEFAULT 0,
  "locked_until" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_authorized_account_id_key" ON "users"("authorized_account_id");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- A user's email must equal its allowlisted email (defence in depth).
CREATE FUNCTION amai_user_matches_allowlist() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM authorized_accounts a WHERE a.id = NEW.authorized_account_id AND a.email = NEW.email) THEN
    RAISE EXCEPTION 'user email must match its authorized account';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_allowlist_check BEFORE INSERT OR UPDATE OF email, authorized_account_id ON "users"
  FOR EACH ROW EXECUTE FUNCTION amai_user_matches_allowlist();

CREATE TABLE "device_sessions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "device_name" VARCHAR(120) NOT NULL,
  "platform" VARCHAR(20) NOT NULL DEFAULT 'android',
  "ip" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "revoke_reason" VARCHAR(60),
  CONSTRAINT "device_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "device_sessions_user_id_revoked_at_idx" ON "device_sessions"("user_id", "revoked_at");

CREATE TABLE "refresh_tokens" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

CREATE TABLE "push_tokens" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "token" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "invalid_at" TIMESTAMPTZ(6),
  CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");
CREATE INDEX "push_tokens_session_id_idx" ON "push_tokens"("session_id");

-- E2EE key material
CREATE TABLE "identity_keys" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "public_key" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "identity_keys_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "identity_keys_user_id_revoked_at_idx" ON "identity_keys"("user_id", "revoked_at");
-- At most one active identity key per user.
CREATE UNIQUE INDEX "identity_keys_one_active_per_user" ON "identity_keys"("user_id") WHERE "revoked_at" IS NULL;

CREATE TABLE "key_backups" (
  "user_id" UUID NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "nonce" VARCHAR(64) NOT NULL,
  "salt" VARCHAR(64) NOT NULL,
  "kdf_params" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "key_backups_pkey" PRIMARY KEY ("user_id")
);

-- Conversations
CREATE TABLE "conversations" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_participants" (
  "conversation_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("conversation_id", "user_id")
);

CREATE TABLE "messages" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "sender_id" UUID NOT NULL,
  "client_id" VARCHAR(64) NOT NULL,
  "type" "message_type" NOT NULL,
  "ciphertext" TEXT,
  "nonce" VARCHAR(64),
  "enc_version" SMALLINT NOT NULL DEFAULT 1,
  "reply_to_id" UUID,
  "forwarded" BOOLEAN NOT NULL DEFAULT false,
  "status_id" UUID,
  "pinned_at" TIMESTAMPTZ(6),
  "pinned_by_id" UUID,
  "edited_at" TIMESTAMPTZ(6),
  "deleted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sync_seq" BIGINT NOT NULL DEFAULT nextval('message_sync_seq'::regclass),
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messages_payload_check" CHECK ("deleted_at" IS NOT NULL OR ("ciphertext" IS NOT NULL AND "nonce" IS NOT NULL))
);
CREATE UNIQUE INDEX "messages_sender_id_client_id_key" ON "messages"("sender_id", "client_id");
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at" DESC);
CREATE INDEX "messages_conversation_id_sync_seq_idx" ON "messages"("conversation_id", "sync_seq");
CREATE INDEX "messages_conversation_id_pinned_at_idx" ON "messages"("conversation_id", "pinned_at");

CREATE TABLE "message_attachments" (
  "id" UUID NOT NULL,
  "uploader_id" UUID NOT NULL,
  "message_id" UUID,
  "kind" "attachment_kind" NOT NULL,
  "object_key" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "uploaded_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_attachments_size_check" CHECK ("size_bytes" > 0)
);
CREATE UNIQUE INDEX "message_attachments_object_key_key" ON "message_attachments"("object_key");
CREATE INDEX "message_attachments_message_id_idx" ON "message_attachments"("message_id");
CREATE INDEX "message_attachments_uploader_id_created_at_idx" ON "message_attachments"("uploader_id", "created_at");

CREATE TABLE "message_receipts" (
  "message_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "delivered_at" TIMESTAMPTZ(6),
  "read_at" TIMESTAMPTZ(6),
  CONSTRAINT "message_receipts_pkey" PRIMARY KEY ("message_id", "user_id")
);
CREATE INDEX "message_receipts_user_id_read_at_idx" ON "message_receipts"("user_id", "read_at");

CREATE TABLE "reactions" (
  "message_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "emoji" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reactions_pkey" PRIMARY KEY ("message_id", "user_id")
);

-- Statuses
CREATE TABLE "statuses" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "kind" "status_kind" NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "nonce" VARCHAR(64) NOT NULL,
  "attachment_id" UUID,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "statuses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "statuses_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '72 hours 1 minute')
);
CREATE UNIQUE INDEX "statuses_attachment_id_key" ON "statuses"("attachment_id");
CREATE INDEX "statuses_user_id_expires_at_idx" ON "statuses"("user_id", "expires_at");
CREATE INDEX "statuses_expires_at_idx" ON "statuses"("expires_at");

CREATE TABLE "status_views" (
  "status_id" UUID NOT NULL,
  "viewer_id" UUID NOT NULL,
  "viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "status_views_pkey" PRIMARY KEY ("status_id", "viewer_id")
);

-- Calls
CREATE TABLE "call_records" (
  "id" UUID NOT NULL,
  "caller_id" UUID NOT NULL,
  "callee_id" UUID NOT NULL,
  "type" "call_type" NOT NULL,
  "state" "call_state" NOT NULL DEFAULT 'ringing',
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answered_at" TIMESTAMPTZ(6),
  "ended_at" TIMESTAMPTZ(6),
  "end_reason" VARCHAR(40),
  CONSTRAINT "call_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "call_records_parties_check" CHECK ("caller_id" <> "callee_id")
);
CREATE INDEX "call_records_caller_id_started_at_idx" ON "call_records"("caller_id", "started_at" DESC);
CREATE INDEX "call_records_callee_id_started_at_idx" ON "call_records"("callee_id", "started_at" DESC);

CREATE TABLE "call_recordings" (
  "id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "consented_by_id" UUID NOT NULL,
  "consented_at" TIMESTAMPTZ(6) NOT NULL,
  "attachment_id" UUID,
  "ciphertext" TEXT,
  "nonce" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "call_recordings_attachment_id_key" ON "call_recordings"("attachment_id");
CREATE INDEX "call_recordings_call_id_idx" ON "call_recordings"("call_id");

-- Settings
CREATE TABLE "user_settings" (
  "user_id" UUID NOT NULL,
  "show_last_seen" BOOLEAN NOT NULL DEFAULT true,
  "show_online" BOOLEAN NOT NULL DEFAULT true,
  "read_receipts" BOOLEAN NOT NULL DEFAULT true,
  "typing_indicators" BOOLEAN NOT NULL DEFAULT true,
  "notification_preview" "notification_preview" NOT NULL DEFAULT 'full',
  "message_sound" VARCHAR(40) NOT NULL DEFAULT 'system_default',
  "call_ringtone" VARCHAR(40) NOT NULL DEFAULT 'system_default',
  "vibrate" BOOLEAN NOT NULL DEFAULT true,
  "status_notifications" BOOLEAN NOT NULL DEFAULT true,
  "delivery_notifications" BOOLEAN NOT NULL DEFAULT false,
  "auto_download" JSONB NOT NULL DEFAULT '{"wifi":["image","voice","video","document"],"mobile":["image","voice"]}',
  "media_quality" VARCHAR(20) NOT NULL DEFAULT 'standard',
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "theme_preferences" (
  "user_id" UUID NOT NULL,
  "mode" VARCHAR(10) NOT NULL DEFAULT 'dark',
  "accent" VARCHAR(20) NOT NULL DEFAULT 'rose',
  "bubble_style" VARCHAR(20) NOT NULL DEFAULT 'rounded',
  "font_scale" REAL NOT NULL DEFAULT 1.0,
  "wallpaper" VARCHAR(80) NOT NULL DEFAULT 'none',
  "haptics" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "theme_preferences_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "theme_preferences_font_scale_check" CHECK ("font_scale" BETWEEN 0.8 AND 1.4)
);

CREATE TABLE "audit_events" (
  "id" BIGSERIAL NOT NULL,
  "user_id" UUID,
  "type" VARCHAR(60) NOT NULL,
  "ip" VARCHAR(64),
  "user_agent" VARCHAR(300),
  "meta" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_events_type_created_at_idx" ON "audit_events"("type", "created_at");
CREATE INDEX "audit_events_user_id_created_at_idx" ON "audit_events"("user_id", "created_at");

-- Foreign keys
ALTER TABLE "users" ADD CONSTRAINT "users_authorized_account_id_fkey" FOREIGN KEY ("authorized_account_id") REFERENCES "authorized_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "device_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "device_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity_keys" ADD CONSTRAINT "identity_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "key_backups" ADD CONSTRAINT "key_backups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_pinned_by_id_fkey" FOREIGN KEY ("pinned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "status_views" ADD CONSTRAINT "status_views_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "status_views" ADD CONSTRAINT "status_views_viewer_id_fkey" FOREIGN KEY ("viewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_records" ADD CONSTRAINT "call_records_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_records" ADD CONSTRAINT "call_records_callee_id_fkey" FOREIGN KEY ("callee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "call_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "theme_preferences" ADD CONSTRAINT "theme_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Bump sync_seq on every message update so /sync returns edits, deletes and pins.
CREATE FUNCTION amai_bump_message_seq() RETURNS trigger AS $$
BEGIN
  NEW.sync_seq := nextval('message_sync_seq');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER messages_bump_seq BEFORE UPDATE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION amai_bump_message_seq();
