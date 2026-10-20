import { Router } from "express";
import { z } from "zod";
import { ah } from "../../middleware/errors.js";
import { parse } from "../../middleware/validate.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import * as auth from "./service.js";
import { publicUser } from "../users/service.js";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, "Use at least 10 characters").max(200);
const deviceName = z.string().trim().min(1).max(120).default("Android device");

export const authRouter = Router();

authRouter.post(
  "/setup",
  authLimiter,
  ah(async (req, res) => {
    const body = parse(
      z.object({ email, setupCode: z.string().trim().min(6).max(32), password, displayName: z.string().trim().min(1).max(60), deviceName }),
      req.body,
    );
    const { user, tokens } = await auth.setupAccount(body, { ip: req.ip, userAgent: req.get("user-agent"), deviceName: body.deviceName });
    res.status(201).json({ user: publicUser(user), ...tokens });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(200), deviceName }), req.body);
    const { user, tokens } = await auth.login(body, { ip: req.ip, userAgent: req.get("user-agent"), deviceName: body.deviceName });
    res.json({ user: publicUser(user), ...tokens });
  }),
);

authRouter.post(
  "/refresh",
  authLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    res.json(await auth.refresh(body.refreshToken, { ip: req.ip }));
  }),
);

authRouter.post(
  "/logout",
  requireAuth,
  ah(async (req, res) => {
    const { userId, sessionId } = authOf(req);
    await auth.logout(userId, sessionId, req.ip);
    res.status(204).end();
  }),
);

authRouter.post(
  "/change-password",
  requireAuth,
  authLimiter,
  ah(async (req, res) => {
    const { userId, sessionId } = authOf(req);
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }), req.body);
    await auth.changePassword(userId, sessionId, body.currentPassword, body.newPassword);
    res.status(204).end();
  }),
);

// There is intentionally no /register route. Accounts exist only via `npm run provision`.
