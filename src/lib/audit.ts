import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

export type AuditType =
  | "login_success" | "login_failed" | "login_locked" | "login_unauthorized_email"
  | "account_setup" | "logout" | "refresh_reuse_detected" | "session_revoked"
  | "password_changed" | "identity_key_rotated" | "key_backup_updated"
  | "socket_auth_failed" | "provisioning" | "recording_consented" | "recording_deleted";

export async function audit(type: AuditType, opts: { userId?: string | null; ip?: string | null; userAgent?: string | null; meta?: Record<string, unknown> } = {}) {
  try {
    await prisma.auditEvent.create({
      data: {
        type,
        userId: opts.userId ?? null,
        ip: opts.ip?.slice(0, 64) ?? null,
        userAgent: opts.userAgent?.slice(0, 300) ?? null,
        meta: (opts.meta ?? {}) as object,
      },
    });
  } catch (err) {
    logger.error({ err, type }, "audit write failed");
  }
}
