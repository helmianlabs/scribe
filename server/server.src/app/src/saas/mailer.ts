/**
 * Outbound email (magic links). Provider "resend" posts to the Resend API; provider "dev"
 * appends to a local outbox file (and an in-memory list for tests) and sends nothing.
 * The magic-link URL is never written to the server log.
 */
import { appendFileSync } from "node:fs";
import type { SaasConfig } from "./config.js";

export interface Mail { to: string; subject: string; html: string; text: string; }
export interface Mailer { send(m: Mail): Promise<{ delivered: boolean; provider: string }>; outbox: Mail[]; }

export function makeMailer(cfg: SaasConfig, fetchImpl: typeof fetch = fetch): Mailer {
  const outbox: Mail[] = [];
  return {
    outbox,
    async send(m) {
      if (cfg.mail.provider === "off") {
        throw new Error("Email sign-in is not enabled. Use the try path at /try.");
      }
      if (cfg.mail.provider === "resend") {
        const key = process.env.RESEND_API_KEY;
        if (!key || !cfg.mail.from) throw new Error("Email is not configured (RESEND_API_KEY and MAIL_FROM).");
        const r = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ from: cfg.mail.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
        });
        if (!r.ok) throw new Error(`Email provider refused the message (HTTP ${r.status}).`);
        return { delivered: true, provider: "resend" };
      }
      outbox.push(m);
      try { appendFileSync(cfg.mail.outboxFile, JSON.stringify({ at: new Date().toISOString(), ...m }) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
      return { delivered: false, provider: "dev" };
    },
  };
}
