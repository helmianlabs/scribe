/**
 * Helmian Scribe entry point. SCRIBE_MODE (or the older MEMORY_MODE) selects the server:
 *   single (default) — Sam's self-host server: one archive, passphrase consent (./single.ts)
 *   saas             — hosted multi-tenant server: accounts, plans, billing (./saas/main.ts)
 */
// SCRIBE_MODE is the new name; MEMORY_MODE keeps working.
const mode = (process.env.SCRIBE_MODE || process.env.MEMORY_MODE || "single").trim().toLowerCase();
if (mode === "saas") await import("./saas/main.js");
else if (mode === "single") await import("./single.js");
else throw new Error(`Unknown MEMORY_MODE "${mode}" (SCRIBE_MODE / MEMORY_MODE: use "single" or "saas")`);
export {};
