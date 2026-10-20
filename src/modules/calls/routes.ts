import { Router } from "express";
import { z } from "zod";
import { ah } from "../../middleware/errors.js";
import { parse } from "../../middleware/validate.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { ciphertext, nonce } from "../messages/schemas.js";
import * as svc from "./service.js";

export const callsRouter = Router();
callsRouter.use(requireAuth);

callsRouter.get("/ice-servers", (req, res) => {
  res.json(svc.iceServers(authOf(req).userId));
});

callsRouter.get(
  "/",
  ah(async (req, res) => {
    const q = parse(z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    res.json({ calls: await svc.callHistory(authOf(req).userId, q.before, q.limit) });
  }),
);

// REST fallbacks for the socket events (used from notification actions / CallKit when no socket is up).
callsRouter.post(
  "/",
  ah(async (req, res) => {
    const { type } = parse(z.object({ type: z.enum(["voice", "video"]) }), req.body);
    res.status(201).json(await svc.startCall(authOf(req).userId, type));
  }),
);
callsRouter.post(
  "/:id/accept",
  ah(async (req, res) => {
    res.json(await svc.acceptCall(authOf(req).userId, parse(z.string().uuid(), req.params.id)));
  }),
);
callsRouter.post(
  "/:id/end",
  ah(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.enum(["hangup", "rejected", "busy", "failed"]).default("hangup") }), req.body ?? {});
    res.json(await svc.finishCall(authOf(req).userId, parse(z.string().uuid(), req.params.id), reason));
  }),
);

callsRouter.get(
  "/recordings",
  ah(async (req, res) => {
    res.json({ recordings: await svc.listRecordings(authOf(req).userId) });
  }),
);
callsRouter.put(
  "/recordings/:id",
  ah(async (req, res) => {
    const body = parse(z.object({ attachmentId: z.string().uuid(), ciphertext, nonce }), req.body);
    await svc.attachRecording(authOf(req).userId, parse(z.string().uuid(), req.params.id), body);
    res.status(204).end();
  }),
);
callsRouter.delete(
  "/recordings/:id",
  ah(async (req, res) => {
    await svc.deleteRecording(authOf(req).userId, parse(z.string().uuid(), req.params.id));
    res.status(204).end();
  }),
);
