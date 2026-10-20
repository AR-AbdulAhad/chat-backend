import { Router } from "express";
import { z } from "zod";
import { ah } from "../../middleware/errors.js";
import { parse } from "../../middleware/validate.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import * as svc from "./service.js";
import { env, maxBytesForKind } from "../../config/env.js";

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

const kinds = ["image", "video", "audio", "voice", "document", "sticker", "status_media", "call_recording"] as const;

/** Compression / size limits the app applies before upload (configurable on the server). */
mediaRouter.get("/limits", (_req, res) => {
  res.json({ maxBytes: maxBytesForKind, imageMaxDimension: env.IMAGE_MAX_DIMENSION, videoMaxSeconds: env.VIDEO_MAX_SECONDS });
});

mediaRouter.post(
  "/uploads",
  ah(async (req, res) => {
    const body = parse(z.object({ kind: z.enum(kinds), sizeBytes: z.number().int().positive() }), req.body);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.status(201).json(await svc.createUpload(authOf(req).userId, body.kind, body.sizeBytes, baseUrl));
  }),
);

mediaRouter.post(
  "/uploads/:id/complete",
  ah(async (req, res) => {
    res.json(await svc.completeUpload(authOf(req).userId, parse(z.string().uuid(), req.params.id)));
  }),
);

mediaRouter.get(
  "/:id/url",
  ah(async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.json(await svc.downloadUrl(authOf(req).userId, parse(z.string().uuid(), req.params.id), baseUrl));
  }),
);
