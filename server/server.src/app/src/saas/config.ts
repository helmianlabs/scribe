/**
 * SaaS-mode configuration (MEMORY_MODE=saas). Read once, from the environment, never logged.
 * The self-host single-tenant mode keeps using ../config.ts unchanged.
 */
export interface SaasConfig {
  publicUrl: string;
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  mail: { provider: "resend" | "dev"; from: string | null; outboxFile: string };
  /** Which provider checkout, the billing portal and seat changes go through. Both webhooks stay mounted; each answers 503 until its secret is set. */
  paymentProvider: "stripe" | "paddle";
  paddle: {
    apiKey: string | null;            // PADDLE_API_KEY (server-side secret; sandbox keys contain "_sdbx")
    webhookSecret: string | null;     // PADDLE_WEBHOOK_SECRET (the notification destination's endpoint secret key)
    clientToken: string | null;       // PADDLE_CLIENT_TOKEN (public by design; "test_..." sandbox, "live_..." live)
    prices: { personal: string | null; personalYearly: string | null; team: string | null };  // pri_... ids
    allowLive: boolean;               // PADDLE_ALLOW_LIVE=yes-i-mean-live
  };
  stripe: { secretKey: string | null; webhookSecret: string | null; prices: { personal: string | null; personalYearly: string | null; team: string | null }; allowLive: boolean };
  sessionTtlDays: number;
  magicLinkTtlMin: number;
  cookieSecure: boolean;
  limitsOverride: Partial<Record<"free" | "personal" | "team", { maxMemories?: number | null; maxBytes?: number; maxTypedRules?: number | null; maxCallsPerDay?: number }>>;
}

function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

export function loadSaasConfig(over: Partial<SaasConfig> = {}): SaasConfig {
  const publicUrl = (over.publicUrl ?? env("PUBLIC_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
  const resendKey = env("RESEND_API_KEY");
  const from = env("MAIL_FROM");
  const provider = (env("MAIL_PROVIDER") as "resend" | "dev" | null) ?? (resendKey && from ? "resend" : "dev");
  let limitsOverride = {};
  try { limitsOverride = JSON.parse(env("PLAN_LIMITS_JSON") || "{}"); } catch { /* ignore */ }
  return {
    publicUrl,
    port: Number(env("PORT") || 8080),
    databaseUrl: over.databaseUrl ?? env("DATABASE_URL") ?? "",
    databaseSsl: env("DATABASE_SSL") !== "disable",
    mail: { provider, from, outboxFile: env("MAIL_OUTBOX_FILE") || "/tmp/smm-mail-outbox.jsonl" },
    paymentProvider: env("PAYMENT_PROVIDER") === "paddle" ? "paddle" : "stripe",
    paddle: {
      apiKey: env("PADDLE_API_KEY"),
      webhookSecret: env("PADDLE_WEBHOOK_SECRET"),
      clientToken: env("PADDLE_CLIENT_TOKEN"),
      prices: { personal: env("PADDLE_PRICE_PERSONAL"), personalYearly: env("PADDLE_PRICE_PERSONAL_YEARLY"), team: env("PADDLE_PRICE_TEAM") },
      allowLive: env("PADDLE_ALLOW_LIVE") === "yes-i-mean-live",
    },
    stripe: {
      secretKey: env("STRIPE_SECRET_KEY"),
      webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
      prices: { personal: env("STRIPE_PRICE_PERSONAL"), personalYearly: env("STRIPE_PRICE_PERSONAL_YEARLY"), team: env("STRIPE_PRICE_TEAM") },
      allowLive: env("STRIPE_ALLOW_LIVE") === "yes-i-mean-live",
    },
    sessionTtlDays: Number(env("SESSION_TTL_DAYS") || 30),
    magicLinkTtlMin: Number(env("MAGIC_LINK_TTL_MIN") || 15),
    cookieSecure: publicUrl.startsWith("https://"),
    limitsOverride,
    ...over,
  };
}
