import { readFileSync } from "node:fs";
import { cert, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";
import { env, isTest } from "../config/env.js";
import { logger } from "./logger.js";

export interface PushPayload {
  /** All values must be strings (FCM data messages). */
  data: Record<string, string>;
  /** "high" is required for calls and messages to be delivered in Doze. */
  priority?: "high" | "normal";
  ttlSeconds?: number;
  collapseKey?: string;
}

export interface PushSender {
  send(token: string, payload: PushPayload): Promise<"ok" | "invalid_token" | "error">;
}

class FcmSender implements PushSender {
  private app: App | null = null;

  constructor() {
    if (!env.FCM_ENABLED) {
      return;
    }

    const sa = this.loadServiceAccount();
    if (!sa) {
      if (!isTest) {
        logger.warn(
          "FCM disabled: set FIREBASE_SERVICE_ACCOUNT_JSON, individual FIREBASE_* env variables, or FIREBASE_SERVICE_ACCOUNT_PATH to enable push notifications",
        );
      }
      return;
    }

    try {
      this.app = initializeApp({ credential: cert(sa) }, "amai");
    } catch (err: any) {
      logger.error({ err }, "Failed to initialize Firebase Admin app");
    }
  }

  private loadServiceAccount(): any {
    // 1. Direct JSON or Base64 string in .env
    if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
        const jsonStr = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
        return JSON.parse(jsonStr);
      } catch (err) {
        logger.error({ err }, "Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON");
        return null;
      }
    }

    // 2. Individual environment variables in .env
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      return {
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      };
    }

    // 3. Fallback: file path
    if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      try {
        return JSON.parse(readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
      } catch (err) {
        logger.error({ err }, "Failed to read FIREBASE_SERVICE_ACCOUNT_PATH");
        return null;
      }
    }

    return null;
  }

  async send(token: string, payload: PushPayload) {
    if (!this.app) return "error" as const;
    // Data-only messages: the app decides what to display (and can decrypt
    // previews on-device). The server never puts plaintext in a push.
    const message: Message = {
      token,
      data: payload.data,
      android: {
        priority: payload.priority ?? "high",
        ttl: (payload.ttlSeconds ?? 86400) * 1000,
        collapseKey: payload.collapseKey,
      },
    };
    try {
      await getMessaging(this.app).send(message);
      return "ok" as const;
    } catch (err: any) {
      const code: string = err?.errorInfo?.code ?? err?.code ?? "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) {
        return "invalid_token" as const;
      }
      logger.error({ err: { code, message: err?.message } }, "fcm send failed");
      return "error" as const;
    }
  }
}

let current: PushSender | null = null;
export const pushSender: PushSender = {
  send: (t, p) => {
    current ??= new FcmSender();
    return current.send(t, p);
  },
};
export function setPushSender(impl: PushSender) {
  current = impl;
}
