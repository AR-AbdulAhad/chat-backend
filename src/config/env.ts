import "dotenv/config";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.string().default("info"),
  TRUST_PROXY: z.coerce.number().int().default(1),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  CORS_ORIGINS: z.string().default(""),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 chars"),
  JWT_ISSUER: z.string().default("amai"),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(180).default(30),
  SETUP_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),
  LOGIN_MAX_FAILURES: z.coerce.number().int().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().default(15),

  UPLOAD_DIR: z.string().default("./uploads"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("amai-private"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: bool.default(true),
  S3_URL_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(300),

  MAX_IMAGE_BYTES: z.coerce.number().int().default(16 * 1024 * 1024),
  MAX_VIDEO_BYTES: z.coerce.number().int().default(100 * 1024 * 1024),
  MAX_AUDIO_BYTES: z.coerce.number().int().default(32 * 1024 * 1024),
  MAX_DOCUMENT_BYTES: z.coerce.number().int().default(100 * 1024 * 1024),
  MAX_RECORDING_BYTES: z.coerce.number().int().default(300 * 1024 * 1024),
  IMAGE_MAX_DIMENSION: z.coerce.number().int().default(2560),
  VIDEO_MAX_SECONDS: z.coerce.number().int().default(180),

  MESSAGE_EDIT_WINDOW_MIN: z.coerce.number().int().default(15),
  MESSAGE_DELETE_WINDOW_HOURS: z.coerce.number().int().default(48),
  MAX_CIPHERTEXT_CHARS: z.coerce.number().int().default(96_000),

  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FCM_ENABLED: bool.default(true),

  STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  TURN_URLS: z.string().default(""),
  TURN_SECRET: z.string().default(""),
  TURN_TTL_SEC: z.coerce.number().int().default(3600),
  CALL_RING_TIMEOUT_SEC: z.coerce.number().int().default(45),
  RECORDING_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  RUN_WORKER_IN_PROCESS: bool.default(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable list; never print secret values.
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

export const maxBytesForKind: Record<string, number> = {
  image: env.MAX_IMAGE_BYTES,
  sticker: 2 * 1024 * 1024,
  avatar: 5 * 1024 * 1024,
  video: env.MAX_VIDEO_BYTES,
  status_media: env.MAX_VIDEO_BYTES,
  audio: env.MAX_AUDIO_BYTES,
  voice: env.MAX_AUDIO_BYTES,
  document: env.MAX_DOCUMENT_BYTES,
  call_recording: env.MAX_RECORDING_BYTES,
};
