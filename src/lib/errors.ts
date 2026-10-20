export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, msg?: string, details?: unknown) => new HttpError(400, code, msg, details);
export const unauthorized = (code = "unauthorized", msg?: string) => new HttpError(401, code, msg);
export const forbidden = (code = "forbidden", msg?: string) => new HttpError(403, code, msg);
export const notFound = (code = "not_found", msg?: string) => new HttpError(404, code, msg);
export const conflict = (code: string, msg?: string) => new HttpError(409, code, msg);
export const tooMany = (code = "rate_limited", msg?: string) => new HttpError(429, code, msg);
