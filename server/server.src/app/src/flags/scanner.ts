/**
 * Flags scanner: deterministic, local, no network. Runs on every save_memory and on every
 * flag reported through the Flags API, BEFORE anything is stored.
 *
 *  - secret / pii findings are REDACTED from the text ([REDACTED:<rule>]) and flagged.
 *  - harmful_code findings are flagged (text kept: a memory about a dangerous command is
 *    still useful), severity high/critical.
 *  - hedging / evasion phrases are flagged low severity.
 *
 * Patterns are intentionally conservative; every finding carries the rule id so a false
 * positive can be pointed at and tuned.
 */
export type Severity = "low" | "medium" | "high" | "critical";
export type FlagCategory = "secret" | "pii" | "harmful_code" | "hedging" | "moderation" | "privacy" | "other";

export const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export interface Finding {
  category: FlagCategory;
  rule: string;
  severity: Severity;
  reason: string;
  /** span in the ORIGINAL text that is redacted (secret/pii only) */
  start?: number;
  end?: number;
  /** for non-redacting findings: a short, already-safe snippet */
  snippet?: string;
}

export interface ScanResult {
  findings: Finding[];
  redacted: string;
  redactions: number;
}

interface RedactRule {
  rule: string;
  category: "secret" | "pii";
  severity: Severity;
  reason: string;
  re: RegExp;
  /** capture group holding the secret value (default: whole match) */
  group?: number;
  validate?: (value: string, full: string) => boolean;
}

const PLACEHOLDER = /^(\*+|x{3,}|\.{3,}|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|<[^>]*>|\[redacted[^\]]*\]|redacted|changeme|example|your[-_a-z]*|process\.env\.[\w.]+|os\.environ.*|null|none|undefined|true|false)$/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const REDACT_RULES: RedactRule[] = [
  { rule: "secret.private_key", category: "secret", severity: "critical", reason: "A private key block was found.",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { rule: "secret.aws_access_key", category: "secret", severity: "critical", reason: "An AWS access key id was found.",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "secret.aws_secret_key", category: "secret", severity: "critical", reason: "An AWS secret access key was found.",
    re: /\baws_secret_access_key\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi, group: 1 },
  { rule: "secret.github_token", category: "secret", severity: "critical", reason: "A GitHub token was found.",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { rule: "secret.anthropic_key", category: "secret", severity: "critical", reason: "An Anthropic API key was found.",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: "secret.stripe_key", category: "secret", severity: "critical", reason: "A Stripe secret or restricted key was found.",
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { rule: "secret.stripe_webhook_secret", category: "secret", severity: "high", reason: "A Stripe webhook signing secret was found.",
    re: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
  { rule: "secret.openai_key", category: "secret", severity: "critical", reason: "An OpenAI-style API key was found.",
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { rule: "secret.slack_token", category: "secret", severity: "critical", reason: "A Slack token was found.",
    re: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g },
  { rule: "secret.google_api_key", category: "secret", severity: "high", reason: "A Google API key was found.",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "secret.resend_key", category: "secret", severity: "high", reason: "A Resend API key was found.",
    re: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g },
  { rule: "secret.jwt", category: "secret", severity: "high", reason: "A signed token (JWT) was found.",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
  { rule: "secret.bearer_token", category: "secret", severity: "high", reason: "A bearer token was found.",
    re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, group: 1 },
  { rule: "secret.connection_string_password", category: "secret", severity: "critical",
    reason: "A database/service connection string with a password was found.",
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/]+:([^\s@/]+)@/gi, group: 1,
    validate: (v) => !PLACEHOLDER.test(v) },
  { rule: "secret.password_assignment", category: "secret", severity: "high",
    reason: "A password, passphrase, token or API key was written out.",
    re: /\b(?:pass(?:word|wd|phrase)?|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b["']?\s*(?:[:=]|\bis\b)\s*["'`]?([^\s"'`,;)]{6,})/gi,
    group: 1,
    validate: (v) => !PLACEHOLDER.test(v) && !/^\[REDACTED/.test(v) },
  { rule: "pii.card_number", category: "pii", severity: "high", reason: "A payment card number was found.",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (v) => { const d = v.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d); } },
  { rule: "pii.ssn", category: "pii", severity: "high", reason: "A US Social Security number was found.",
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { rule: "pii.ssn_labeled", category: "pii", severity: "high", reason: "A US Social Security number was found.",
    re: /\b(?:SSN|social security(?: number| no\.?)?)\s*[:#]?\s*((?!000|666|9\d\d)\d{3}\s?(?!00)\d{2}\s?(?!0000)\d{4})\b/gi, group: 1 },
];

interface DetectRule {
  rule: string;
  category: "harmful_code" | "hedging";
  severity: Severity;
  reason: string;
  re: RegExp;
  check?: (m: RegExpExecArray, text: string) => { severity: Severity; reason: string } | null;
}

const DEFAULT_SAFE_INSTALL_HOSTS = [
  "sh.rustup.rs", "get.docker.com", "deno.land", "bun.sh", "astral.sh", "get.pnpm.io",
  "install.python-poetry.org", "raw.githubusercontent.com/homebrew", "fnm.vercel.app",
  "cli.github.com", "tailscale.com", "get.helm.sh", "nixos.org", "claude.ai", "ollama.com",
];
function safeHosts(): string[] {
  const extra = (process.env.FLAGS_SAFE_INSTALL_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_SAFE_INSTALL_HOSTS, ...extra];
}

const CRED_FILE = /(?:~|\$HOME|\/home\/[\w.-]+|\/root)?\/?\.(?:ssh\/id_[a-z0-9_]+|aws\/credentials|netrc|docker\/config\.json|kube\/config|git-credentials|npmrc|pgpass)|\/etc\/shadow\b/i;
const NET_SEND = /\b(?:curl|wget|nc|ncat|netcat|scp|rsync|ftp|Invoke-WebRequest|iwr|Invoke-RestMethod|fetch\(|requests\.post|http\.post)\b/i;

const DETECT_RULES: DetectRule[] = [
  { rule: "harmful.rm_rf_root", category: "harmful_code", severity: "critical",
    reason: "Recursive force delete of the root, home, or every file.",
    re: /\brm\s+(?:-[a-zA-Z]*(?:rf|fr)[a-zA-Z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\s+(?:--no-preserve-root\s+)?(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\*|\.\/?\*?)(?=\s|$|;|&|\||"|'|`)/g },
  { rule: "harmful.fork_bomb", category: "harmful_code", severity: "critical", reason: "A fork bomb.",
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/g },
  { rule: "harmful.disk_wipe", category: "harmful_code", severity: "critical", reason: "Formats or overwrites a whole disk.",
    re: /\b(?:mkfs(?:\.\w+)?\s+\/dev\/\w+|dd\s+[^\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|disk\d|xvd[a-z])|>\s*\/dev\/sd[a-z]\b|format\s+[a-z]:\s*\/[qy])/gi },
  { rule: "harmful.chmod_777_root", category: "harmful_code", severity: "high", reason: "Opens every file on the system to everyone.",
    re: /\bchmod\s+-R\s+0?777\s+\/(?=\s|$)/g },
  { rule: "harmful.reverse_shell", category: "harmful_code", severity: "critical", reason: "A reverse shell that hands control of the machine to a remote host.",
    re: /(?:\bbash\s+-i\s+>&\s*\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^\n]*\s-[ec]\s+\/bin\/(?:ba)?sh|\bsocket\.socket\([^\n]*\)[^\n]*\bsubprocess\.call\(\[?["']\/bin\/(?:ba)?sh)/g },
  { rule: "harmful.pipe_to_shell", category: "harmful_code", severity: "high",
    reason: "Downloads a script and runs it straight in a shell.",
    re: /\b(?:curl|wget)\b[^\n|;]*?(https?:\/\/[^\s"'|;)]+)[^\n|;]*\|\s*(?:sudo\s+(?:-\w+\s+)*)?(?:ba|z|da|k)?sh\b/gi,
    check: (m) => {
      const url = (m[1] || "").toLowerCase().replace(/^https?:\/\//, "");
      if (safeHosts().some((h) => url === h || url.startsWith(h + "/") || url.startsWith(h + "?"))) return null;
      const host = url.split(/[/?#]/)[0];
      return { severity: "high", reason: `Downloads a script from ${host} (not on the known installer list) and runs it straight in a shell.` };
    } },
  { rule: "harmful.powershell_download_exec", category: "harmful_code", severity: "high",
    reason: "PowerShell downloads code and executes it.",
    re: /\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString|Net\.WebClient)\b|\b(?:DownloadString|iwr|irm)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/gi },
  { rule: "harmful.obfuscated_eval", category: "harmful_code", severity: "high",
    reason: "Decodes hidden code and runs it (obfuscated eval).",
    re: /\beval\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent|String\.fromCharCode)\s*\(|\bnew\s+Function\s*\(\s*atob\s*\(|\bexec\s*\(\s*(?:base64\.b64decode|zlib\.decompress|codecs\.decode|marshal\.loads|bytes\.fromhex)\s*\(|\becho\s+["']?[A-Za-z0-9+/=]{24,}["']?\s*\|\s*base64\s+(?:-d|--decode|-D)\s*\|\s*(?:ba|z)?sh\b|\bpowershell(?:\.exe)?\b[^\n]*\s-(?:e|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{24,}/gi },
  { rule: "harmful.credential_exfiltration", category: "harmful_code", severity: "critical",
    reason: "Reads a credential file or the environment and sends it over the network.",
    re: /[^\n]+/g,
    check: (m) => {
      const line = m[0];
      const credFile = CRED_FILE.test(line);
      const envDump = /\b(?:printenv|env)\b\s*(?:\||>)|\bprocess\.env\b[^\n]*\b(?:fetch|axios|http)|\bos\.environ\b[^\n]*\brequests\./i.test(line);
      if ((credFile || envDump) && NET_SEND.test(line)) return { severity: "critical", reason: "Reads a credential file or the environment and sends it over the network." };
      return null;
    } },
  { rule: "harmful.drop_database", category: "harmful_code", severity: "medium", reason: "Drops a whole database or schema.",
    re: /\bDROP\s+(?:DATABASE|SCHEMA)\b(?:\s+IF\s+EXISTS)?\s+[\w"]+/gi },
  { rule: "harmful.disable_security", category: "harmful_code", severity: "medium", reason: "Turns off a security control.",
    re: /\b(?:setenforce\s+0|ufw\s+disable|Set-MpPreference\s+-DisableRealtimeMonitoring\s+\$?true|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|git\s+commit\b[^\n]*--no-verify|curl\b[^\n]*\s(?:-k|--insecure)\b)/gi },
];

const HEDGING_PHRASES: Array<[RegExp, string]> = [
  [/\bas an ai(?: language model)?\b/i, "as an AI"],
  [/\bi (?:can(?:'|’)?t|cannot|am unable to|'m unable to|am not able to|'m not able to) (?:verify|confirm|guarantee)\b/i, "can't verify"],
  [/\bi (?:don(?:'|’)?t|do not) have (?:access to )?(?:real-time|current|up-to-date|live) (?:information|data|access)\b/i, "no real-time access"],
  [/\b(?:i may be|i could be|i might be) (?:wrong|mistaken)\b/i, "may be wrong"],
  [/\bi(?:'m| am) not (?:entirely |completely |100% )?(?:sure|certain)\b/i, "not sure"],
  [/\bit(?:'s| is) (?:possible|likely|unclear) (?:that|whether)\b/i, "it's possible that"],
  [/\b(?:i|we) (?:can(?:'|’)?t|cannot|won(?:'|’)?t) (?:help|assist) with (?:that|this)\b/i, "can't help with that"],
  [/\bi(?:'m| am) (?:unable|not able) to (?:share|discuss|provide|do) (?:that|this)\b/i, "unable to share"],
  [/\b(?:please )?consult (?:a|an|your) (?:professional|lawyer|attorney|doctor|expert|advisor)\b/i, "consult a professional"],
  [/\bfor (?:legal|safety|policy) reasons,? i (?:can(?:'|’)?t|cannot)\b/i, "for policy reasons I can't"],
  [/\b(?:to the best of my knowledge|as of my (?:last|knowledge) (?:update|cutoff))\b/i, "knowledge cutoff"],
  [/\bi (?:apologi[sz]e|'m sorry),? but\b/i, "apology refusal"],
];

function shortSnippet(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Scan text. Returns findings and the text with every secret/PII span replaced. */
export function scanText(text: string): ScanResult {
  const spans: Array<{ start: number; end: number; rule: string }> = [];
  const findings: Finding[] = [];

  for (const r of REDACT_RULES) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(text))) {
      const value = r.group ? m[r.group] : m[0];
      if (!value) continue;
      if (r.validate && !r.validate(value, m[0])) continue;
      const offset = r.group ? m[0].indexOf(value) : 0;
      const start = m.index + offset;
      const end = start + value.length;
      if (spans.some((s) => start < s.end && end > s.start)) continue; // already covered by an earlier (stronger) rule
      spans.push({ start, end, rule: r.rule });
      findings.push({ category: r.category, rule: r.rule, severity: r.severity, reason: r.reason, start, end });
      if (m[0].length === 0) r.re.lastIndex++;
    }
  }

  spans.sort((a, b) => a.start - b.start);
  let redacted = "";
  let pos = 0;
  for (const s of spans) {
    redacted += text.slice(pos, s.start) + `[REDACTED:${s.rule.replace(/^(secret|pii)\./, "")}]`;
    pos = s.end;
  }
  redacted += text.slice(pos);

  // Detection runs on the REDACTED text, so snippets never carry a secret.
  const seen = new Set<string>();
  for (const r of DETECT_RULES) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(redacted))) {
      if (m[0].length === 0) { r.re.lastIndex++; continue; }
      const verdict = r.check ? r.check(m, redacted) : { severity: r.severity, reason: r.reason };
      if (!verdict) continue;
      const key = `${r.rule}:${shortSnippet(m[0], 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ category: r.category, rule: r.rule, severity: verdict.severity, reason: verdict.reason, snippet: shortSnippet(m[0]) });
    }
  }

  const hedges = HEDGING_PHRASES.filter(([re]) => re.test(redacted)).map(([, label]) => label);
  if (hedges.length) {
    findings.push({
      category: "hedging", rule: "hedging.phrases", severity: "low",
      reason: `Hedging or evasion phrases: ${hedges.join(", ")}.`,
    });
  }

  return { findings, redacted, redactions: spans.length };
}

/** Redact only (for excerpts, contexts and anything else headed for storage or an alert). */
export function redact(text: string): string {
  return scanText(text).redacted;
}

export function maxSeverity(fs: Array<{ severity: Severity }>): Severity | null {
  let best: Severity | null = null;
  for (const f of fs) if (best === null || severityRank(f.severity) > severityRank(best)) best = f.severity;
  return best;
}
