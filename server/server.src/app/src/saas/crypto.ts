import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const newId = () => randomUUID();
/** Short URL-safe slug for the per-tenant MCP URL (lowercase, no ambiguous chars). */
export function newSlug(len = 10): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[b[i] % alphabet.length];
  return s;
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
