/**
 * Entry point. MEMORY_MODE selects the server:
 *   single (default) — Sam's self-host server: one archive, passphrase consent (./single.ts)
 *   saas             — hosted multi-tenant server: accounts, plans, billing (./saas/main.ts)
 */
const mode = (process.env.MEMORY_MODE || "single").trim().toLowerCase();
if (mode === "saas") await import("./saas/main.js");
else if (mode === "single") await import("./single.js");
else throw new Error(`Unknown MEMORY_MODE "${mode}" (use "single" or "saas")`);
export {};
