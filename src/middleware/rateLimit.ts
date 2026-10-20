import { rateLimit } from "express-rate-limit";
import { isTest } from "../config/env.js";

/** Login / setup / refresh: 10 attempts per 15 minutes per IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 1000 : 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "rate_limited" } },
});

/** General API limit per IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isTest ? 100000 : 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "rate_limited" } },
});
