import { Router } from "express";
import { z } from "zod";
import { ah } from "../../middleware/errors.js";
import { parse } from "../../middleware/validate.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import * as svc from "./service.js";
import { editSchema, pinSchema, reactionSchema, receiptsSchema, sendSchema } from "./schemas.js";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const uuid = z.string().uuid();

messagesRouter.get(
  "/",
  ah(async (req, res) => {
    const q = parse(
      z.object({
        before: z.coerce.date().optional(),
        after: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        pinned: z.enum(["true", "false"]).optional(),
      }),
      req.query,
    );
    res.json(await svc.listMessages(authOf(req).userId, { ...q, pinned: q.pinned === "true" }));
  }),
);

messagesRouter.get(
  "/sync",
  ah(async (req, res) => {
    const q = parse(
      z.object({ since: z.string().regex(/^\d{1,19}$/).default("0"), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      req.query,
    );
    res.json(await svc.syncMessages(authOf(req).userId, BigInt(q.since), q.limit));
  }),
);

messagesRouter.post(
  "/",
  ah(async (req, res) => {
    const body = parse(sendSchema, req.body);
    const { message, duplicate } = await svc.sendMessage(authOf(req).userId, body);
    res.status(duplicate ? 200 : 201).json(message);
  }),
);

messagesRouter.patch(
  "/:id",
  ah(async (req, res) => {
    const body = parse(editSchema, req.body);
    res.json(await svc.editMessage(authOf(req).userId, parse(uuid, req.params.id), body.ciphertext, body.nonce));
  }),
);

messagesRouter.delete(
  "/:id",
  ah(async (req, res) => {
    await svc.deleteForEveryone(authOf(req).userId, parse(uuid, req.params.id));
    res.status(204).end();
  }),
);

messagesRouter.put(
  "/:id/reaction",
  ah(async (req, res) => {
    const body = parse(reactionSchema, req.body);
    await svc.react(authOf(req).userId, parse(uuid, req.params.id), body.emoji);
    res.status(204).end();
  }),
);

messagesRouter.put(
  "/:id/pin",
  ah(async (req, res) => {
    const body = parse(pinSchema, req.body);
    await svc.pin(authOf(req).userId, parse(uuid, req.params.id), body.pinned);
    res.status(204).end();
  }),
);

messagesRouter.post(
  "/receipts",
  ah(async (req, res) => {
    const body = parse(receiptsSchema, req.body);
    res.json({ updated: await svc.markReceipts(authOf(req).userId, body.messageIds, body.kind) });
  }),
);

messagesRouter.post(
  "/read-all",
  ah(async (req, res) => {
    res.json({ updated: await svc.markAllRead(authOf(req).userId) });
  }),
);
