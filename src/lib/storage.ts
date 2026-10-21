import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Storage interface for uploads and media attachments.
 * Implements local filesystem storage with signed URLs.
 */
export interface Storage {
  presignPut(key: string, sizeBytes: number, baseUrl?: string): Promise<string>;
  presignGet(key: string, baseUrl?: string): Promise<string>;
  head(key: string): Promise<{ sizeBytes: number } | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function getUploadDir(): string {
  const uploadDir = path.resolve(process.cwd(), env.UPLOAD_DIR || "./uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  return uploadDir;
}

export function getSafeFilePath(key: string): string {
  const uploadDir = getUploadDir();
  // Normalize and prevent directory traversal
  const safePath = path.resolve(uploadDir, ...key.split("/"));
  if (!safePath.startsWith(uploadDir)) {
    throw new Error("Invalid storage key path");
  }
  return safePath;
}

export function signStorageUrl(action: "get" | "put", key: string, expiresInSec = env.S3_URL_TTL_SEC): { expires: number; sig: string } {
  const expires = Math.floor(Date.now() / 1000) + expiresInSec;
  const data = `${action}:${key}:${expires}`;
  const sig = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(data).digest("hex");
  return { expires, sig };
}

export function verifyStorageSignature(action: "get" | "put", key: string, expires: number, sig: string): boolean {
  if (Math.floor(Date.now() / 1000) > expires) return false;
  const data = `${action}:${key}:${expires}`;
  const expectedSig = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(data).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"));
  } catch {
    return false;
  }
}

class LocalStorage implements Storage {
  async presignPut(key: string, _sizeBytes: number, baseUrl?: string): Promise<string> {
    const effectiveBase = env.PUBLIC_API_URL?.startsWith("https://") ? env.PUBLIC_API_URL : (baseUrl || env.PUBLIC_API_URL);
    const base = effectiveBase.replace(/\/+$/, "");
    const { expires, sig } = signStorageUrl("put", key);
    return `${base}/api/v1/storage/file?key=${encodeURIComponent(key)}&expires=${expires}&sig=${sig}`;
  }

  async presignGet(key: string, baseUrl?: string): Promise<string> {
    const effectiveBase = env.PUBLIC_API_URL?.startsWith("https://") ? env.PUBLIC_API_URL : (baseUrl || env.PUBLIC_API_URL);
    const base = effectiveBase.replace(/\/+$/, "");
    const { expires, sig } = signStorageUrl("get", key);
    return `${base}/api/v1/storage/file?key=${encodeURIComponent(key)}&expires=${expires}&sig=${sig}`;
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const filePath = getSafeFilePath(key);
      const stat = await fs.promises.stat(filePath);
      return { sizeBytes: stat.size };
    } catch (err: any) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const filePath = getSafeFilePath(key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, body);
  }

  async remove(key: string): Promise<void> {
    try {
      const filePath = getSafeFilePath(key);
      await fs.promises.unlink(filePath);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

let current: Storage = new LocalStorage();
export const storage: Storage = {
  presignPut: (k, s, b) => current.presignPut(k, s, b),
  presignGet: (k, b) => current.presignGet(k, b),
  head: (k) => current.head(k),
  put: (k, b, t) => current.put(k, b, t),
  remove: (k) => current.remove(k),
};

export function setStorage(impl: Storage) {
  current = impl;
}
