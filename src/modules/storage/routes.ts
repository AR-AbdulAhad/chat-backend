import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getSafeFilePath, verifyStorageSignature } from "../../lib/storage.js";
import { logger } from "../../lib/logger.js";

export const storageRouter = Router();

// PUT /api/v1/storage/file?key=...&expires=...&sig=...
storageRouter.put("/file", async (req, res) => {
  const key = req.query.key as string;
  const expires = Number(req.query.expires);
  const sig = req.query.sig as string;

  if (!key || !expires || !sig || !verifyStorageSignature("put", key, expires, sig)) {
    return res.status(403).json({ error: { code: "invalid_signature", message: "Forbidden or expired storage signature" } });
  }

  try {
    const filePath = getSafeFilePath(key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const out = fs.createWriteStream(filePath);
    await pipeline(req, out);
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, key }, "Failed to write uploaded file to disk");
    return res.status(500).json({ error: { code: "upload_failed" } });
  }
});

// GET /api/v1/storage/file?key=...&expires=...&sig=...
storageRouter.get("/file", async (req, res) => {
  const key = req.query.key as string;
  const expires = Number(req.query.expires);
  const sig = req.query.sig as string;

  if (!key || !expires || !sig || !verifyStorageSignature("get", key, expires, sig)) {
    return res.status(403).json({ error: { code: "invalid_signature", message: "Forbidden or expired storage signature" } });
  }

  try {
    const filePath = getSafeFilePath(key);
    try {
      await fs.promises.access(filePath);
    } catch {
      return res.status(404).json({ error: { code: "file_not_found" } });
    }

    res.setHeader("Content-Type", "application/octet-stream");
    const src = fs.createReadStream(filePath);
    await pipeline(src, res);
  } catch (err) {
    logger.error({ err, key }, "Failed to stream file from disk");
    if (!res.headersSent) {
      return res.status(500).json({ error: { code: "download_failed" } });
    }
  }
});
