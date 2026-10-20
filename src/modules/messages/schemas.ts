import { z } from "zod";
import { env } from "../../config/env.js";

export const b64 = z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "must be base64");
export const ciphertext = b64.min(16).max(env.MAX_CIPHERTEXT_CHARS);
export const nonce = b64.min(16).max(64);

export const messageTypes = [
  "text", "image", "video", "audio", "voice", "document", "location", "live_location",
  "contact", "sticker", "gif", "link", "status_reply", "call_event",
] as const;

export const sendSchema = z.object({
  clientId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  type: z.enum(messageTypes),
  ciphertext,
  nonce,
  encVersion: z.number().int().min(1).max(10).optional(),
  replyToId: z.string().uuid().nullish(),
  forwarded: z.boolean().optional(),
  statusId: z.string().uuid().nullish(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
});

export const editSchema = z.object({ ciphertext, nonce });
export const reactionSchema = z.object({
  emoji: z.string().min(1).max(32).regex(/^[^\sA-Za-z0-9<>]+$/u, "must be an emoji").nullable(),
});
export const pinSchema = z.object({ pinned: z.boolean() });
export const receiptsSchema = z.object({
  messageIds: z.array(z.string().uuid()).min(1).max(500),
  kind: z.enum(["delivered", "read"]),
});
