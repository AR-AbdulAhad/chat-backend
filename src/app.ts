import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { authRouter } from "./modules/auth/routes.js";
import { conversationRouter, usersRouter } from "./modules/users/routes.js";
import { messagesRouter } from "./modules/messages/routes.js";
import { mediaRouter } from "./modules/media/routes.js";
import { statusesRouter } from "./modules/statuses/routes.js";
import { keysRouter } from "./modules/keys/routes.js";
import { devicesRouter, settingsRouter } from "./modules/settings/routes.js";
import { callsRouter } from "./modules/calls/routes.js";
import { storageRouter } from "./modules/storage/routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  // The Android app is not a browser and needs no CORS; only explicitly listed origins (e.g. an admin tool) are allowed.
  const origins = env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false, credentials: false }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const v1 = express.Router();
  v1.use(apiLimiter);
  v1.use("/auth", authRouter);
  v1.use("/users", usersRouter);
  v1.use("/conversation", conversationRouter);
  v1.use("/messages", messagesRouter);
  v1.use("/media", mediaRouter);
  v1.use("/statuses", statusesRouter);
  v1.use("/keys", keysRouter);
  v1.use("/settings", settingsRouter);
  v1.use("/devices", devicesRouter);
  v1.use("/calls", callsRouter);
  v1.use("/storage", storageRouter);
  app.use("/api/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
