import { pino } from "pino";
import { env, isTest } from "../config/env.js";

export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,
  // Never log credentials, tokens or E2EE payloads.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.refreshToken",
      "*.accessToken",
      "*.setupCode",
      "*.ciphertext",
      "*.token",
    ],
    censor: "[redacted]",
  },
});
