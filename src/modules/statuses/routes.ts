import { Router } from "express";
import { z } from "zod";
import { ah } from "../../middleware/errors.js";
import { parse } from "../../middleware/validate.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { ciphertext, nonce } from "../messages/schemas.js";
import * as svc from "./service.js";

export const statusesRouter = Router();
statusesRouter.use(requireAuth);

statusesRouter.get(
  "/",
  ah(async (req, res) => {
    res.json({ statuses: await svc.activeStatuses(authOf(req).userId) });
  }),
);

statusesRouter.post(
  "/",
  ah(async (req, res) => {
    const body = parse(
      z.object({
        kind: z.enum(["photo", "video", "text"]),
        ciphertext,
        nonce,
        attachmentId: z.string().uuid().nullish(),
        expiresInHours: z.union([z.literal(24), z.literal(48), z.literal(72)]).default(24),
      }),
      req.body,
    );
    res.status(201).json(await svc.createStatus(authOf(req).userId, body));
  }),
);

statusesRouter.post(
  "/:id/view",
  ah(async (req, res) => {
    await svc.viewStatus(authOf(req).userId, parse(z.string().uuid(), req.params.id));
    res.status(204).end();
  }),
);

statusesRouter.delete(
  "/:id",
  ah(async (req, res) => {
    await svc.deleteStatus(authOf(req).userId, parse(z.string().uuid(), req.params.id));
    res.status(204).end();
  }),
);
