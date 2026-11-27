// src/librarian/types.ts
var UNSORTED = "unsorted";

// src/librarian/parse.ts
var TAG_LINE = /^\s*\[tags:\s*([^\]]*)\]\s*(?:\r?\n|$)/i;
var NOTEBOOK = /^Shared Memory\s*[—–-]\s*(.+)$/i;
function parseTags(text) {
  const m = TAG_LINE.exec(text ?? "");
  if (!m) return [];
  return m[1].split(/[,;]/).map((t) => normalise(t)).filter(Boolean);
}
function stripTagLine(text) {
  return (text ?? "").replace(TAG_LINE, "");
}
function notebookLabel(conversationName) {
  if (!conversationName) return null;
  const m = NOTEBOOK.exec(conversationName.trim());
  return m ? normalise(m[1]) : null;
}
function normalise(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
var CHAT_ROLES = /* @__PURE__ */ new Set(["human", "assistant", "user", "system"]);
function resolveSource(item) {
  if (item.source && item.source.trim()) return normalise(item.source);
  const s = item.sender ? normalise(item.sender) : "";
  if (s && !CHAT_ROLES.has(s)) return s;
  return s ? "claude-archive" : null;
}

// src/librarian/shape.ts
var PR = [
  /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i,
  /\bpull request\b/i,
  /\bPR\s*#\d+/,
  /\bmerge(d)? (pr|pull request|branch)\b/i
];
var COMMIT = [
  /\bcommit\s+[0-9a-f]{7,40}\b/i,
  /\b[0-9a-f]{7,40}\b.*\b(commit(ted)?|pushed)\b/i,
  /\bgit (commit|push|rebase|cherry-pick)\b/i,
  /github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{7,40}/i
];
var ERROR = [
  /\bTraceback \(most recent call last\)/,
  /^\s*at [\w$.<>]+ \(.+:\d+:\d+\)/m,
  /\b(?:[A-Z]\w*Error|Exception)\b:\s/,
  /\bERR_[A-Z_]+\b/,
  /\b(?:HTTP\s*)?(?:500|502|503|504)\b.*\b(error|failed)\b/i,
  /\bstack trace\b/i,
  /\bsegmentation fault\b/i
];
var CODE_FENCE = /```[\s\S]*?```/;
var CODE_LINE = /^\s*(?:import |export |const |let |function |def |class |return |if \(|for \(|SELECT |INSERT |CREATE |\}|\{|<\/?\w+[^>]*>)/i;
function detectShape(text) {
  const t = text ?? "";
  if (PR.some((r) => r.test(t))) return "pr";
  if (COMMIT.some((r) => r.test(t))) return "commit";
  if (ERROR.some((r) => r.test(t))) return "error";
  if (CODE_FENCE.test(t)) return "code";
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length >= 3) {
    const codeish = lines.filter((l) => CODE_LINE.test(l) || /;\s*$/.test(l)).length;
    if (codeish / lines.length >= 0.5) return "code";
  }
  return "chat";
}

// src/librarian/match.ts
var cache = /* @__PURE__ */ new Map();
function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function wordRegex(word) {
  const key = word.toLowerCase();
  let r = cache.get(key);
  if (!r) {
    const body = key.trim().split(/\s+/).map(escape).join("[\\s_-]+");
    r = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:e?s)?(?![\\p{L}\\p{N}])`, "iu");
    cache.set(key, r);
  }
  return r;
}
function findWords(text, words = []) {
  return words.filter((w) => wordRegex(w).test(text));
}

// src/librarian/engine.ts
var LAYER_RANK = { manual: 6, learned: 5, custom: 4, content: 3, shape: 2, source: 1 };
var MAX_CHAIN_PASSES = 4;
var patternCache = /* @__PURE__ */ new Map();
function compilePattern(src) {
  if (patternCache.has(src)) return patternCache.get(src);
  let re = null;
  if (src.length <= 3e3) {
    try {
      re = new RegExp(src, "u");
    } catch {
      re = null;
    }
  }
  patternCache.set(src, re);
  return re;
}
function firstPatternHit(text, patterns) {
  for (const src of patterns) {
    const m = compilePattern(src)?.exec(text);
    if (m) return m[0];
  }
  return null;
}
function evaluateRule(rule, ctx) {
  if (rule.enabled === false) return null;
  const w = rule.when;
  const matched = [];
  let conditions = 0;
  if (w.source?.length) {
    conditions++;
    const s = ctx.source;
    const hit = s ? w.source.find((x) => normalise(x) === s) : void 0;
    if (!hit) return null;
    matched.push(`source "${hit}"`);
  }
  if (w.shape?.length) {
    conditions++;
    if (!w.shape.includes(ctx.shape)) return null;
    matched.push(`shape ${ctx.shape}`);
  }
  if (w.tags?.length) {
    conditions++;
    const pool = (rule.layer === "custom" || rule.layer === "learned") && ctx.chainTags ? ctx.chainTags : ctx.tags;
    const hit = w.tags.find((t) => pool.includes(normalise(t)));
    if (!hit) return null;
    matched.push(`tag "${normalise(hit)}"`);
  }
  if (w.patterns?.length) {
    conditions++;
    if (rule.layer === "custom" || rule.layer === "learned") return null;
    const hit = firstPatternHit(ctx.text, w.patterns);
    if (!hit) return null;
    matched.push(`pattern match "${hit.trim().slice(0, 40)}"`);
  }
  if (w.conversationWords?.length) {
    conditions++;
    const hits = findWords(ctx.conv, w.conversationWords);
    if (!hits.length) return null;
    matched.push(`notebook name word "${hits[0]}"`);
  }
  if (w.anyWords?.length) {
    conditions++;
    const hits = findWords(ctx.text, w.anyWords);
    if (!hits.length) return null;
    matched.push(...hits.slice(0, 3).map((h) => `word "${h}"`));
  }
  if (w.allWords?.length) {
    conditions++;
    const hits = findWords(ctx.text, w.allWords);
    if (hits.length !== w.allWords.length) return null;
    matched.push(`all of ${w.allWords.map((x) => `"${x}"`).join(", ")}`);
  }
  if (w.withAny?.length) {
    conditions++;
    const hits = findWords(ctx.text, w.withAny);
    if (!hits.length) return null;
    matched.push(`with context word "${hits[0]}"`);
  }
  if (w.noneWords?.length) {
    if (findWords(ctx.text, w.noneWords).length) return null;
  }
  if (w.nonePatterns?.length && rule.layer !== "custom" && rule.layer !== "learned") {
    if (firstPatternHit(ctx.text, w.nonePatterns)) return null;
  }
  return conditions > 0 ? matched : null;
}
function sortRules(rules) {
  return [...rules].sort(
    (a, b) => b.priority - a.priority || LAYER_RANK[b.layer] - LAYER_RANK[a.layer] || a.id.localeCompare(b.id)
  );
}
var ignoreCache = /* @__PURE__ */ new Map();
function applyIgnore(text, book) {
  const ignored = [];
  let out = text;
  for (const ig of book.ignore ?? []) {
    let re = ignoreCache.get(ig.pattern);
    if (!re) {
      re = new RegExp(ig.pattern, "giu");
      ignoreCache.set(ig.pattern, re);
    }
    out = out.replace(re, (m) => {
      ignored.push(m);
      return " ";
    });
  }
  return { text: out, ignored };
}
function classify(item, book, extraRules = []) {
  const raw = item.text ?? "";
  const tags = parseTags(raw);
  const body = stripTagLine(raw);
  const { text, ignored } = applyIgnore(body, book);
  const source = resolveSource(item);
  const shape = detectShape(body);
  const conv = notebookLabel(item.conversationName) ?? item.conversationName ?? "";
  const ctx = { text, source, shape, tags, conv };
  const sorted = sortRules([...book.rules, ...extraRules]);
  const allRules = new Map(sorted.map((r) => [r.id, r]));
  const visibleTags = new Set(tags);
  const tagAddedBy = /* @__PURE__ */ new Map();
  const fired = /* @__PURE__ */ new Map();
  for (let pass = 1; pass <= MAX_CHAIN_PASSES; pass++) {
    const passCtx = { ...ctx, chainTags: [...visibleTags] };
    const newlyFired = [];
    sorted.forEach((rule2, order) => {
      if (fired.has(rule2.id)) return;
      const matched = evaluateRule(rule2, passCtx);
      if (!matched) return;
      const hit = { ruleId: rule2.id, layer: rule2.layer, category: rule2.category, priority: rule2.priority, matched, description: rule2.description };
      if (pass > 1) {
        hit.pass = pass;
        hit.via = (rule2.when.tags ?? []).map(normalise).filter((t) => tagAddedBy.has(t)).map((t) => `${t} (from rule ${tagAddedBy.get(t)})`);
        if (hit.via.length) hit.matched = matched.map((m) => m.startsWith('tag "') ? `${m} added by rule ${tagAddedBy.get(m.slice(5, -1))}` : m);
      }
      fired.set(rule2.id, { hit, order });
      newlyFired.push(rule2);
    });
    let grew = false;
    for (const rule2 of newlyFired) {
      for (const t of rule2.addTags ?? []) {
        const n = normalise(t);
        if (!visibleTags.has(n)) {
          visibleTags.add(n);
          tagAddedBy.set(n, rule2.id);
          grew = true;
        }
      }
    }
    if (!newlyFired.length || !grew) break;
  }
  const hits = [...fired.values()].sort((a, b) => a.order - b.order).map((x) => x.hit);
  const outTags = new Set(tags);
  for (const h of hits) for (const t of allRules.get(h.ruleId)?.addTags ?? []) outTags.add(normalise(t));
  if (shape !== "chat") outTags.add(shape);
  if (source) outTags.add(`from:${source}`);
  const winner = hits.find((h) => h.category);
  if (!winner) {
    return {
      itemId: item.id,
      category: UNSORTED,
      tags: [...outTags].sort(),
      rulebook: book.id,
      winningRule: null,
      hits,
      shape,
      source,
      explanation: "No rule matched, so it went to the unsorted tray. Nothing is lost; move it and the Librarian can learn a rule."
    };
  }
  const rule = allRules.get(winner.ruleId);
  const ignoredNote = ignored.length ? ` Ignored as infrastructure names, not topic: ${[...new Set(ignored)].slice(0, 3).map((x) => `"${x.trim().slice(0, 40)}"`).join(", ")}.` : "";
  return {
    itemId: item.id,
    category: winner.category,
    tags: [...outTags].sort(),
    rulebook: book.id,
    winningRule: winner.ruleId,
    hits,
    shape,
    source,
    explanation: `Filed in "${winner.category}" by rule ${winner.ruleId} (${winner.layer} layer): ${rule.description} Matched ${winner.matched.join(", ")}.${ignoredNote}`
  };
}
var CONTEXT_RULE_ID = "context.conversation";
function classifyBatch(items, book, extraRules = [], opts = { minCount: 3, minShare: 0.4 }) {
  const filings = items.map((i) => classify(i, book, extraRules));
  const byConv = /* @__PURE__ */ new Map();
  items.forEach((it, idx) => {
    const k = it.conversationName ?? "";
    if (!k) return;
    if (!byConv.has(k)) byConv.set(k, []);
    byConv.get(k).push(idx);
  });
  for (const [conv, idxs] of byConv) {
    const counts = /* @__PURE__ */ new Map();
    let filed = 0;
    for (const i of idxs) if (filings[i].category !== UNSORTED) {
      filed++;
      counts.set(filings[i].category, (counts.get(filings[i].category) ?? 0) + 1);
    }
    if (!filed) continue;
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (n < opts.minCount || n / filed < opts.minShare) continue;
    for (const i of idxs) {
      if (filings[i].category !== UNSORTED) continue;
      filings[i] = {
        ...filings[i],
        category: top,
        winningRule: CONTEXT_RULE_ID,
        hits: [...filings[i].hits, { ruleId: CONTEXT_RULE_ID, layer: "content", category: top, priority: 0, matched: [`conversation "${conv.slice(0, 80)}"`] }],
        explanation: `Filed in "${top}" with the rest of its conversation "${conv.slice(0, 80)}" (${n} of ${filed} filed messages there are "${top}"). It had no trigger words of its own.`
      };
    }
  }
  return filings;
}

// src/librarian/entities.ts
var ci = (w) => w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
var ciAlt = (words) => `(?:${words.map(ci).join("|")})`;
var CAP = String.raw`[A-Z][a-z]{2,}(?:['’-][A-Za-z]+)?`;
var NOT_NAMES = String.raw`(?:The|This|That|These|Those|There|Here|It|He|She|We|They|You|Who|What|When|Where|Why|How|My|Our|Your|Their|His|Her|Its|Some|Any|No|Yes|Not|And|But|Or|So|If|Then|Okay|Hey|Sounds|Today|Tomorrow|Yesterday|Meeting|Call|Calls|Dinner|Lunch|Breakfast|Coffee|Stay|Staying|Stayed|Park|Parked|Work|Working|Worked|Live|Lives|Living|Meet|Meets|Stop|Stopped|Fuel|Fueled|Arrive|Arrived|Deliver|Delivered|Load|Loaded|Unload|Unloaded|Pickup|Drop|Dropped|Sold|Bought|Buy|Eat|Ate|Left|Leave|Going|Gone|Home|Back|Running|Built|Update|Updated|Stuck|Waiting|Wait|Check|Checked|Heading|Headed|Driving|Drive|Drove|Hauling|Hauled|Haul|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)`;
var NAME = String.raw`(?!${NOT_NAMES}\b)${CAP}`;
var NAME2 = String.raw`${NAME}(?: ${CAP})?`;
var STATES = String.raw`(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Wisconsin|Wyoming|AL|AK|AZ|AR|CA|CO|CT|DE|FL|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|WI|WY)`;
var ORG_SUFFIX = String.raw`(?:[Tt]rucking|[Tt]ransport(?:ation)?|[Ll]ogistics|[Ff]reight|[Hh]auling|[Cc]arriers?|[Ff]arms?|[Cc]reamery|[Cc]o-op|Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Co\.|Company|Ltd\.?|Bank|Insurance|Holdings|Partners|Group|Supply|Services|Dairy)`;
var CUE_VERBS = String.raw`(?:${ciAlt(["call", "called", "calling", "text", "texted", "texting", "email", "emailed", "emailing", "message", "messaged", "messaging", "phone", "phoned", "met with", "meeting with", "spoke to", "spoke with", "talk to", "talk with", "talked to", "talked with", "talking to", "talking with", "pick up", "picked up", "picking up", "ask", "asked", "remind", "introduce", "introduced"])})`;
var ENTITY_RULES = (guard) => [
  {
    id: "content.org-named",
    layer: "content",
    category: "organizations",
    priority: 565,
    addTags: ["organization"],
    when: { patterns: [String.raw`\b(?!${NOT_NAMES}\b)${CAP}(?: ${CAP})* ${ORG_SUFFIX}\b`], noneWords: guard },
    description: "A company name (a capitalised name followed by Trucking, Transport, Farms, Inc, LLC, Co-op, ...). Files above everyday day-job talk, below any business of yours that is named."
  },
  {
    id: "content.person-at-org",
    layer: "content",
    category: "people",
    priority: 176,
    addTags: ["person", "organization"],
    when: { patterns: [String.raw`\b${NAME} ${ciAlt(["at", "from", "with"])} ${NAME}\b`], noneWords: guard },
    description: 'A person at a company ("Brendan at Banyan"): filed under the person, tagged with the company.'
  },
  {
    id: "content.person-cue",
    layer: "content",
    category: "people",
    priority: 174,
    addTags: ["person"],
    when: {
      patterns: [
        String.raw`\b(?:Mr|Mrs|Ms|Miss|Dr)\.? ${NAME}\b`,
        String.raw`\b${CUE_VERBS} (?:${ciAlt(["with", "to"])} )?${NAME2}\b`,
        String.raw`(?:^|[.!?]\s+)${NAME} ${ciAlt(["called", "texted", "emailed", "messaged", "phoned", "said", "asked", "wants", "wanted", "is coming", "arrived", "stopped by", "dropped by"])}\b`
      ],
      noneWords: guard
    },
    description: 'A person is mentioned (a capitalised name after call / text / meet / pick up, or "Mr/Dr Name", or a name that called or said something).'
  },
  {
    id: "content.place-cue",
    layer: "content",
    category: "places",
    priority: 172,
    addTags: ["place"],
    when: {
      patterns: [
        String.raw`\b${CAP}(?: ${CAP})?,? ${STATES}\b`,
        String.raw`\b${ciAlt(["in", "near", "outside", "around", "to", "from", "into", "toward", "visiting", "moved to", "driving to", "headed to"])} ${NAME2}\b(?!['’]s)`
      ],
      noneWords: guard
    },
    description: "A place is named (a city and state, or a capitalised name after in / near / to / from)."
  },
  {
    id: "content.place-words",
    layer: "content",
    category: "places",
    priority: 171,
    addTags: ["place"],
    when: { anyWords: ["airport", "county", "warehouse", "truck stop", "rest area", "city hall", "downtown"], noneWords: guard },
    description: "A kind of place is named (airport, county, warehouse, truck stop, ...)."
  }
];
var ENTITY_RULE_IDS = new Set(
  ENTITY_RULES([]).map((r) => r.id)
);

// src/librarian/vocab.ts
var PROJECTS = {
  "faith-n-light": { name: "Faith N Light", words: ["faith n light", "faith and light", "faith & light", "faithnlight", "fnl", "printify", "tumbler", "beanie", "dad cap", "kjv", "scripture", "meta shop"] },
  helmian: { name: "Helmian", words: ["helmian", "helmion", "helium runner", "herald", "bridge device", "runner box"] },
  "dairyforge-firstuse": {
    name: "DairyForge / FirstUse",
    words: ["dairyforge", "dairy forge", "dairy forage", "dairy farmers of america", "firstuse", "dfa", "dairyport", "saadi", "saudi", "wash tag", "pump start", "gauge app", "gauge-sandbox", "milk moovement"],
    // Sam hauls milk for a living: these words are his day job unless the memory is about the product.
    weak: ["dairy co-op", "co-op", "milk hauler", "wash state", "magic valley", "dairy", "milk", "hauling", "hauler", "haulers", "creamery", "dairyman", "dairymen", "silo", "silos", "gallons", "pump", "pumping", "milk pickup", "wash", "tanker", "first use", "glanbia", "chobani"]
  },
  "forge-tms": {
    name: "Forge TMS",
    words: ["forge tms", "forge-tms", "cora", "load board", "dispatcher", "route code", "hos", "eld", "fleet fwd", "mcleod", "tms"],
    weak: ["freight", "carrier", "dispatch", "loads", "trucking", "broker", "shipper"]
  },
  "shared-memory": { name: "Shared Memory", words: ["shared memory", "claude memory", "claude_memory", "search_memory", "save_memory", "librarian", "mcp door", "beacons"] },
  caldmere: { name: "Caldmere", words: ["caldmere", "unity", "blender", "centaur"] },
  thinkinbuddy: { name: "Thinkinbuddy", words: ["thinkinbuddy", "thinking buddy", "site diary", "actionable app"] }
};
var PRODUCT_CONTEXT = [
  "app",
  "apps",
  "apk",
  "platform",
  "pilot",
  "pitch",
  "pitching",
  "demo",
  "investor",
  "investors",
  "customer",
  "customers",
  "geofence",
  "geofencing",
  "manifest",
  "dashboard",
  "backend",
  "frontend",
  "feature",
  "features",
  "compliance",
  "software",
  "saas",
  "mvp",
  "prototype",
  "startup",
  "product",
  "licensing",
  "contract",
  "revenue",
  "pricing",
  "sell",
  "selling",
  "qr",
  "qr code",
  "simulation",
  "database",
  "api",
  "repo",
  "deploy",
  "app store",
  "play store",
  "dispatch board",
  "auto dispatch",
  "driver app",
  "samsara",
  "integration",
  "market",
  "competitor",
  "competitors",
  "system",
  "screen",
  "display",
  "metric",
  "metrics",
  "data",
  "tracking",
  "scan",
  "automation",
  "workflow",
  "endpoint",
  "schema",
  "ui",
  "pitch deck",
  "founder",
  "company",
  "companies",
  "business",
  "sales",
  "partnership",
  "roi",
  "traceability",
  "audit",
  "research",
  "spec",
  "build",
  "built",
  "code",
  "coding",
  "coded",
  "commit",
  "commits",
  "pushed",
  "typecheck",
  "wired",
  "command",
  "commands",
  "checklist",
  "architecture",
  "button",
  "buttons",
  "tap",
  "photo",
  "photos",
  "website",
  "test",
  "tested",
  "testing",
  "bug",
  "bugs",
  "fix",
  "fixed",
  "workflow",
  "sync",
  "alert",
  "alerts",
  "stubbed",
  "mock",
  "handoff",
  "cip",
  "sign off",
  "voice agent",
  "module",
  "modules",
  "pillar",
  "phase",
  "milestone",
  "version",
  "portal",
  "vendor",
  "vendors",
  "claude",
  "grok",
  "gpt",
  "chatgpt",
  "gemini",
  "cursor",
  "replit",
  "linkedin",
  "post",
  "posts",
  "outreach",
  "email",
  "meeting",
  "msa",
  "deal",
  "savings",
  "per truck",
  "per year",
  "flow rate",
  "flow rates",
  "drivers",
  "fleet",
  "fleets",
  "ids",
  "pilot program",
  "idle time"
];
var JOB_TALK = [
  "my truck",
  "my route",
  "my shift",
  "my load",
  "fueling",
  "fuel up",
  "the yard",
  "unloading",
  "unload",
  "unloaded",
  "loaded",
  "pre trip",
  "post trip",
  "driving",
  "drove",
  "on the road",
  "clock in",
  "clock out",
  "highway",
  "traffic",
  "weigh station",
  "scale house",
  "trailer",
  "truck",
  "trucks",
  "diesel",
  "chains",
  "black ice",
  "miles",
  "mile marker",
  "dock",
  "detention",
  "layover",
  "overtime",
  "paycheck",
  "boss",
  "supervisor"
];
var FINANCE = ["invoice", "invoices", "payment", "paid", "refund", "stripe", "bank", "budget", "tax", "taxes", "irs", "payroll", "expense", "receipt", "subscription", "billing", "price", "pricing", "revenue", "profit", "loan", "credit card", "owe", "owed", "paddle", "lemon squeezy", "gumroad", "dollars"];
var PERSONAL = ["family", "wife", "kids", "son", "daughter", "mom", "dad", "doctor", "diabetes", "insulin", "blood sugar", "vet", "dog", "birthday", "church", "prayer", "vacation", "health", "appointment", "banner", "brother", "sister", "cousin", "girlfriend", "feelings", "mental", "stress", "stressed", "tired", "sleep", "exhausted", "drive home", "my life", "god", "jesus", "faith in god", "carnival"];
var CODE_WORDS = ["repo", "github", "branch", "deploy", "vercel", "docker", "migration", "schema", "typescript", "javascript", "python", "api", "endpoint", "bug", "refactor", "build", "pnpm", "npm", "postgres", "neon", "sql", "hetzner", "caddy", "mcp", "oauth", "worktree"];
var MARKETING = ["linkedin", "facebook", "instagram", "tiktok", "youtube", "reel", "reels", "newsletter", "seo", "outreach", "campaign", "landing page", "waitlist", "product hunt"];
var RESEARCH = ["research", "competitor", "compare", "comparison", "market", "report", "study", "pricing research"];
var PLANNING = ["plan", "roadmap", "todo", "to-do", "next step", "next steps", "punch list", "handoff", "spec", "decision", "decided"];
var DESIGN = ["design", "mockup", "logo", "print file", "artwork", "font", "color", "screenshot", "ui", "ux"];
var AI_TOOLS = ["claude", "claude code", "chatgpt", "gpt", "gemini", "grok", "jarvis", "codex", "cursor", "muse", "midjourney", "llm", "prompt", "prompts", "agent", "agents", "subagent", "voice chat", "tts", "elevenlabs", "handoff", "context window", "/clear", "clear command"];

// src/librarian/presets.ts
var allWords = (p) => [...p.words, ...p.weak ?? []];
var STRONG_WORDS = Object.values(PROJECTS).flatMap((p) => p.words);
var JOB_WEAK = ["milk", "hauling", "hauler", "haulers", "milk hauler", "milk pickup", "tanker", "dairy", "dairyman", "dairymen", "freight", "loads", "trucking", "dispatch"];
var FINANCE_STRICT = ["invoice", "invoices", "payment", "payments", "paid", "refund", "receipt", "payroll", "tax", "taxes", "irs", "expense", "expenses", "bank", "loan", "owe", "owed", "dollars", "budget"];
var AI_NICKNAMES = ["big sister", "big brother", "big brother claude", "big sister claude"];
var projectRules = (priority, prefix = "", strongOnly = false) => Object.entries(PROJECTS).map(([slug2, p]) => ({
  id: `content.project.${slug2}`,
  layer: "content",
  when: { anyWords: strongOnly ? p.words : allWords(p) },
  category: `${prefix}${slug2}`,
  addTags: [slug2],
  priority,
  description: `Mentions ${p.name}.`
}));
var projectNotebookRules = (priority, prefix = "", strongOnly = false) => Object.entries(PROJECTS).map(([slug2, p]) => ({
  id: `content.notebook.${slug2}`,
  layer: "content",
  when: { conversationWords: strongOnly ? p.words : allWords(p) },
  category: `${prefix}${slug2}`,
  addTags: [slug2],
  priority,
  description: `The conversation it came from is about ${p.name}.`
}));
var tagRule = (cat, tags) => ({
  id: `tag.${cat}`,
  layer: "content",
  when: { tags },
  category: cat,
  priority: 800,
  description: `The writer tagged it ${tags.map((t) => `"${t}"`).join(" or ")}.`
});
var topic = (id, cat, words, priority, description, addTags = []) => ({
  id,
  layer: "content",
  when: { anyWords: words },
  category: cat,
  priority,
  description,
  addTags
});
var sharedTagRules = [
  { id: "tag-only.money", layer: "content", when: { anyWords: FINANCE }, addTags: ["money"], priority: 50, description: "Talks about money." },
  { id: "tag-only.personal", layer: "content", when: { anyWords: PERSONAL }, addTags: ["personal"], priority: 50, description: "Personal life." },
  { id: "tag-only.decision", layer: "content", when: { anyWords: ["decided", "decision", "we will", "going with"] }, addTags: ["decision"], priority: 50, description: "Records a decision." }
];
var projectCats = Object.entries(PROJECTS).map(([slug2, p]) => ({ slug: slug2, name: p.name }));
var PRESET_A = {
  id: "preset-a",
  name: "A \u2014 By project",
  description: "Every memory goes in the project it is about. Anything not about a project goes to General, or the unsorted tray.",
  categories: [...projectCats, { slug: "personal", name: "Personal" }, { slug: "general", name: "General" }],
  rules: [
    ...Object.keys(PROJECTS).map((slug2) => tagRule(slug2, [slug2, PROJECTS[slug2].name])),
    ...projectRules(600),
    ...projectNotebookRules(550),
    topic("content.personal", "personal", PERSONAL, 300, "Personal life, not a project."),
    { id: "shape.code.general", layer: "shape", when: { shape: ["code", "pr", "commit", "error"] }, category: "general", priority: 200, description: "Technical item with no project named." },
    ...sharedTagRules
  ]
};
var PRESET_B = {
  id: "preset-b",
  name: "B \u2014 By kind of work",
  description: "Sorted by what kind of work it is: code, money, marketing, research, planning, design, personal.",
  categories: [
    { slug: "code", name: "Code" },
    { slug: "money", name: "Money" },
    { slug: "marketing", name: "Marketing" },
    { slug: "research", name: "Research" },
    { slug: "planning", name: "Planning" },
    { slug: "design", name: "Design" },
    { slug: "personal", name: "Personal" }
  ],
  rules: [
    tagRule("code", ["code"]),
    tagRule("money", ["money", "finance"]),
    tagRule("personal", ["personal"]),
    { id: "shape.code", layer: "shape", when: { shape: ["code", "pr", "commit", "error"] }, category: "code", priority: 450, description: "It is code, a PR, a commit, or an error." },
    topic("content.money", "money", FINANCE, 420, "Talks about money (invoices, payments, pricing, tax).", ["money"]),
    topic("content.personal", "personal", PERSONAL, 410, "Personal life."),
    topic("content.marketing", "marketing", MARKETING, 400, "Marketing, social, or outreach."),
    topic("content.design", "design", DESIGN, 390, "Design or visuals."),
    topic("content.research", "research", RESEARCH, 380, "Research or a comparison."),
    topic("content.code-words", "code", CODE_WORDS, 370, "Technical words (repo, deploy, database...)."),
    topic("content.planning", "planning", PLANNING, 360, "A plan, spec, handoff or decision."),
    ...projectRules(10).map((r) => ({ ...r, category: void 0, id: r.id.replace("content.", "tag-only.") })),
    ...sharedTagRules
  ]
};
var PRESET_C = {
  id: "preset-c",
  name: "C \u2014 Work / personal first, then project",
  description: "Personal life is split off first. Work is then filed by project (work/<project>), or work/general.",
  categories: [
    { slug: "personal", name: "Personal" },
    { slug: "personal/money", name: "Personal money", parent: "personal" },
    { slug: "work/general", name: "Work \u2014 general", parent: "work" },
    ...projectCats.map((c) => ({ slug: `work/${c.slug}`, name: `Work \u2014 ${c.name}`, parent: "work" }))
  ],
  rules: [
    tagRule("personal", ["personal"]),
    { id: "content.personal", layer: "content", when: { anyWords: PERSONAL, noneWords: Object.values(PROJECTS).flatMap(allWords) }, category: "personal", priority: 700, description: "Personal life with no project named." },
    ...projectRules(600, "work/"),
    ...projectNotebookRules(550, "work/"),
    { id: "shape.work", layer: "shape", when: { shape: ["code", "pr", "commit", "error"] }, category: "work/general", priority: 200, description: "Technical work with no project named." },
    topic("content.work-words", "work/general", [...CODE_WORDS, ...MARKETING, ...FINANCE], 150, "Work words with no project named."),
    ...sharedTagRules
  ]
};
var projectContextRules = (priority) => Object.entries(PROJECTS).filter(([, p]) => p.weak?.length).map(([slug2, p]) => ({
  id: `content.project-context.${slug2}`,
  layer: "content",
  when: { anyWords: p.weak, withAny: PRODUCT_CONTEXT },
  category: slug2,
  addTags: [slug2],
  priority: priority(slug2),
  description: `Talks about ${p.name}'s line of work and about the product or business side of it.`
}));
var INFRA_IGNORE = [
  { pattern: String.raw`\b(?:https?|postgres(?:ql)?|ssh|git)://\S+`, why: "URLs and connection strings." },
  { pattern: String.raw`\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+`, why: "Email addresses and user@host logins." },
  { pattern: String.raw`(?<![\w/])[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|app|dev|ai|co|shop|sh|cloud|me|xyz|tech)\b(?:/\S*)?`, why: "Hostnames and domains." },
  { pattern: String.raw`(?<![\w])(?:~|\.{1,2})?(?:/[\w.@-]+){2,}/?`, why: "File paths." },
  { pattern: String.raw`\bneon\s+(?:project|db|database)\s*[:=]?\s*["'\u0060]?[\w-]+["'\u0060]?`, why: "Neon project names." },
  { pattern: String.raw`["'\u0060]?[\w-]+["'\u0060]?\s*\(\s*[a-z]+-[a-z]+-\d{6,}\s*\)`, why: "A Neon project name with its id." },
  { pattern: String.raw`\b(?:[a-z]+-[a-z]+)-\d{6,}\b`, why: "Cloud project ids like misty-lake-10000001." },
  { pattern: String.raw`\b(?:project|database|db|bucket|container|image|branch|schema)\s*[:=]\s*["'\u0060]?[\w-]+["'\u0060]?`, why: "key=value infra settings." }
];
var PRESET_D = {
  id: "preset-d",
  name: "D \u2014 All-round default",
  description: "Personal, finance, code, and one shelf per business (Faith N Light, Helmian, DairyForge/FirstUse, Forge TMS, ...). A business name files on its own; its everyday work words (milk, hauling, loads, dispatch) need product context too, otherwise driving and hauling talk is Personal. Infrastructure names (hosts, paths, Neon project ids) are ignored.",
  categories: [
    { slug: "personal", name: "Personal" },
    { slug: "finance", name: "Finance" },
    { slug: "code", name: "Code" },
    { slug: "business", name: "Business (general)" },
    { slug: "ai-tools", name: "AI tools & agents" },
    { slug: "people", name: "People" },
    { slug: "places", name: "Places" },
    { slug: "organizations", name: "Organizations & customers" },
    ...projectCats.map((c) => ({ ...c, parent: "business" }))
  ],
  ignore: INFRA_IGNORE,
  rules: [
    tagRule("personal", ["personal"]),
    tagRule("finance", ["finance", "money"]),
    tagRule("code", ["code"]),
    ...Object.keys(PROJECTS).map((slug2) => tagRule(slug2, [slug2, PROJECTS[slug2].name])),
    // Personal beats project only when no business is named.
    { id: "content.personal", layer: "content", when: { anyWords: PERSONAL, noneWords: [...STRONG_WORDS, ...AI_NICKNAMES] }, category: "personal", priority: 650, description: "Personal life, no business named." },
    ...projectRules(600, "", true),
    // DairyForge's product context outranks a notebook name; generic trucking-product talk (Forge TMS) sits just
    // below notebooks, so inside a DairyForge conversation it stays DairyForge.
    ...projectContextRules((slug2) => slug2 === "forge-tms" ? 545 : 590),
    // Money outranks the day job: "invoice from <a trucking company>" is Finance, not hauling talk.
    { id: "content.finance-job", layer: "content", when: { anyWords: FINANCE_STRICT, withAny: [...JOB_TALK, ...JOB_WEAK], noneWords: [...STRONG_WORDS, ...AI_NICKNAMES] }, category: "finance", priority: 568, description: "Money (invoice, payment, tax, ...) mixed with day-job words: money outranks the day job.", addTags: ["money", "job"] },
    { id: "content.job-talk", layer: "content", when: { shape: ["chat"], anyWords: [...JOB_TALK, ...JOB_WEAK], noneWords: [...STRONG_WORDS, ...PRODUCT_CONTEXT] }, category: "personal", priority: 560, description: "Driving and hauling talk (the day job), with no business named and nothing about the product.", addTags: ["job"] },
    ...projectNotebookRules(550, "", true),
    topic("content.finance", "finance", FINANCE, 400, "Money with no business named (invoices, payments, tax).", ["money"]),
    { id: "shape.code", layer: "shape", when: { shape: ["code", "pr", "commit", "error"] }, category: "code", priority: 200, description: "It is code, a PR, a commit, or an error, with no business named." },
    topic("content.code-words", "code", CODE_WORDS, 190, "Technical words, no business named."),
    topic("content.business", "business", [...MARKETING, "customer", "customers", "client", "sales", "business", "llc", "pitch", "investor", "investors", "licensing", "insurance", "pilot", "launch", "contract"], 180, "General business, no specific business named."),
    topic("content.ai-tools", "ai-tools", AI_TOOLS, 170, "About the AI tools themselves (Claude, ChatGPT, agents, handoffs)."),
    ...ENTITY_RULES([...AI_TOOLS, ...AI_NICKNAMES]),
    ...sharedTagRules
  ]
};
var PRESETS = { A: PRESET_A, B: PRESET_B, C: PRESET_C, D: PRESET_D };

// src/librarian/plainRules.ts
var SHAPES = {
  code: "code",
  pr: "pr",
  prs: "pr",
  "pull requests": "pr",
  commit: "commit",
  commits: "commit",
  error: "error",
  errors: "error",
  chat: "chat",
  chats: "chat"
};
var slug = (s) => s.trim().toLowerCase().replace(/["']/g, "").replace(/\s+/g, "-");
var unquote = (s) => s.trim().replace(/^["']|["']$/g, "").trim();
var PLAIN_RULE_HELP = 'Try: "anything mentioning X goes in Y", "X goes in Y", "anything from SOURCE goes in Y", "anything tagged T goes in Y", or "X is a person / place / customer".';
var ENTITY_KINDS = {
  person: "people",
  people: "people",
  place: "places",
  city: "places",
  town: "places",
  company: "organizations",
  customer: "organizations",
  client: "organizations",
  business: "organizations",
  organization: "organizations",
  organisation: "organizations",
  org: "organizations",
  vendor: "organizations",
  supplier: "organizations"
};
var NOT_A_SUBJECT = /* @__PURE__ */ new Set(["it", "this", "that", "these", "those", "them", "things", "thing", "stuff", "everything", "anything", "all", "any"]);
function parsePlainRule(sentence, id, priority = 900) {
  let s = sentence.trim().replace(/\.$/, "");
  const reorder = /^(?:put|file|move|send)\s+(.+?)\s+(?:in|into|to|under)\s+(?:the\s+)?(.+)$/i.exec(s);
  if (reorder && !/\s(?:goes|go|should go)\s/i.test(s)) s = `${reorder[1]} goes in ${reorder[2]}`;
  const entity = /^(.+?)\s+(?:is|are)\s+(?:a|an|the)?\s*([a-z]+)$/i.exec(s);
  if (entity && ENTITY_KINDS[entity[2].toLowerCase()] && !NOT_A_SUBJECT.has(entity[1].trim().toLowerCase())) {
    const names = entity[1].split(/\s*,\s*|\s+(?:or|and)\s+/i).map(unquote).filter(Boolean);
    if (names.length) {
      const category2 = ENTITY_KINDS[entity[2].toLowerCase()];
      return { id, layer: "custom", when: { anyWords: names }, category: category2, priority, addTags: [category2 === "people" ? "person" : category2 === "places" ? "place" : "organization"], description: `Your rule: "${sentence.trim()}"` };
    }
  }
  let addTags;
  const tail = /\s+and tag (?:it|them)\s+(.+)$/i.exec(s);
  if (tail) {
    addTags = tail[1].split(/\s*,\s*|\s+and\s+/).map(unquote).filter(Boolean);
    s = s.slice(0, tail.index);
  }
  const target = /\s+(?:goes|go|should go|gets filed|get filed)\s+(?:in|into|to|under)\s+(?:the\s+)?(.+?)(?:\s+(?:table|shelf|folder|category))?$/i.exec(s);
  if (!target) return null;
  const category = slug(unquote(target[1]));
  const lhs = s.slice(0, target.index).trim();
  const base = { id, layer: "custom", category, priority, addTags, description: `Your rule: "${sentence.trim()}"` };
  let m = /^(?:anything|everything|all|any)\s+(?:that\s+)?(?:mentioning|mentions|about|with|containing|related to|regarding|concerning)\s+(.+)$/i.exec(lhs);
  if (m) {
    const body = m[1];
    if (/\s+and\s+/i.test(body)) return { ...base, when: { allWords: body.split(/\s+and\s+/i).map(unquote) } };
    return { ...base, when: { anyWords: body.split(/\s*,\s*|\s+or\s+/i).map(unquote).filter(Boolean) } };
  }
  m = /^(?:anything|everything|all)\s+(?:from|written by|saved by)\s+(.+)$/i.exec(lhs);
  if (m) return { ...base, when: { source: m[1].split(/\s*,\s*|\s+or\s+/i).map(unquote) } };
  m = /^(?:anything|everything|all)\s+tagged\s+(.+)$/i.exec(lhs);
  if (m) return { ...base, when: { tags: m[1].split(/\s*,\s*|\s+or\s+/i).map(unquote) } };
  const shapes = lhs.toLowerCase().replace(/^(all|any)\s+/, "").split(/\s*,\s*|\s+(?:and|or)\s+/).map((x) => SHAPES[x.trim()]);
  if (shapes.length && shapes.every(Boolean)) return { ...base, layer: "custom", when: { shape: shapes } };
  const bare = unquote(lhs);
  if (bare && bare.split(/\s+/).length <= 8 && !/^(?:anything|everything|all|any)\b/i.test(bare) && !NOT_A_SUBJECT.has(bare.toLowerCase())) {
    if (/\s+and\s+/i.test(bare)) return { ...base, when: { allWords: bare.split(/\s+and\s+/i).map(unquote).filter(Boolean) } };
    const words = bare.split(/\s*,\s*|\s+or\s+/i).map(unquote).filter(Boolean);
    if (words.length) return { ...base, when: { anyWords: words } };
  }
  return null;
}

// src/librarian/learn.ts
var STOP = new Set("the a an and or but if then of to in on at for with from by is are was were be been it this that these those i you he she we they me my your our their not no yes so as do did does done have has had just can will would should could about into over also more most some any all what when where which who how than there here out up down get got make made like okay ok yeah hey please thanks thank need want going let lets now today tomorrow yesterday one two three".split(" "));
function candidateTriggers(item) {
  const tags = parseTags(item.text);
  const text = stripTagLine(item.text);
  const counts = /* @__PURE__ */ new Map();
  for (const w of text.toLowerCase().match(/[\p{L}][\p{L}\p{N}_-]{3,}/gu) ?? []) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const proper = new Set((text.match(/\b[A-Z][a-zA-Z0-9]{3,}\b/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)));
  const ranked = [...counts.entries()].sort((a, b) => Number(proper.has(b[0])) - Number(proper.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
  return [...tags, ...ranked];
}
function learnFromMove(item, toCategory, book, existing = [], reference = []) {
  const current = classify(item, book, existing);
  if (current.category === toCategory) return { rule: null, note: `Already files into "${toCategory}"; nothing to learn.` };
  const taken = new Set(existing.flatMap((r) => r.when.anyWords ?? []));
  for (const word of candidateTriggers(item).slice(0, 15)) {
    if (taken.has(word)) continue;
    const collisions = reference.filter((r) => {
      if (r.id === item.id || !findWords(stripTagLine(r.text), [word]).length) return false;
      const cat = classify(r, book, existing).category;
      return cat !== UNSORTED && cat !== toCategory;
    }).length;
    if (collisions > 0) continue;
    const rule = {
      id: `learned.${toCategory}.${word}`.replace(/[^a-z0-9._/-]/gi, "_"),
      layer: "learned",
      when: { anyWords: [word] },
      category: toCategory,
      priority: 950,
      description: `Learned when you moved item ${item.id} to "${toCategory}": anything mentioning "${word}" goes there.`
    };
    const after = classify(item, book, [...existing, rule]);
    if (after.category === toCategory) return { rule, note: rule.description };
  }
  return { rule: null, note: "Moved, but no safe trigger word was found, so no rule was learned (the move itself is kept)." };
}

// src/librarian/categories.ts
var MAILBOX = /^for-[a-z0-9][a-z0-9-]*$/;
function normaliseCategory(raw) {
  return raw.trim().toLowerCase().replace(/["']/g, "").replace(/\s+/g, "-");
}
function knownCategories(book, extra = [], filed = []) {
  const out = /* @__PURE__ */ new Set([UNSORTED]);
  for (const c of book.categories) out.add(c.slug);
  for (const r of [...book.rules, ...extra]) if (r.category) out.add(r.category);
  for (const c of filed) if (c) out.add(c);
  return out;
}
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
function checkCategory(raw, known, confirmNew = false) {
  const slug2 = normaliseCategory(raw);
  if (!slug2 || !/^[a-z0-9][a-z0-9/_-]*$/.test(slug2)) {
    return { ok: false, slug: slug2, didYouMean: [], note: `"${raw}" is not a usable shelf name (letters, numbers, - _ / only).` };
  }
  if (known.has(slug2)) return { ok: true, slug: slug2, isNew: false };
  if (MAILBOX.test(slug2)) return { ok: true, slug: slug2, isNew: false };
  if (confirmNew) return { ok: true, slug: slug2, isNew: true };
  const near = [...known].map((k) => ({ k, d: editDistance(slug2, k) })).filter((x) => x.d <= (slug2.length >= 6 ? 2 : 1) || x.k.replace(/-/g, "") === slug2.replace(/-/g, "") || x.k === `${slug2}s` || `${x.k}s` === slug2).sort((a, b) => a.d - b.d || a.k.localeCompare(b.k)).slice(0, 3).map((x) => x.k);
  const list = [...known].filter((k) => k !== UNSORTED).sort().slice(0, 25).join(", ");
  return {
    ok: false,
    slug: slug2,
    didYouMean: near,
    note: `"${slug2}" is not an existing shelf, so nothing was changed.` + (near.length ? ` Did you mean ${near.map((n) => `"${n}"`).join(" or ")}?` : "") + ` If you really want a new shelf called "${slug2}", repeat the request with confirm_new_category: true.` + (list ? ` Existing shelves: ${list}.` : "")
  };
}

// src/librarian/trail.ts
function trailOf(hits, winningRule, category) {
  const list = Array.isArray(hits) ? hits : [];
  const winnerKey = winningRule ?? list.find((h) => h.category && (!category || h.category === category))?.ruleId ?? null;
  return list.map((h, i) => ({
    step: i + 1,
    rule_key: h.ruleId,
    layer: h.layer,
    priority: h.priority,
    files_in: h.category ?? null,
    matched: Array.isArray(h.matched) ? h.matched : [],
    why: h.description ?? null,
    pass: h.pass ?? 1,
    ...h.via?.length ? { needed_tags: h.via } : {},
    decided: h.ruleId === winnerKey
  }));
}
function trailSummary(steps) {
  if (!steps.length) return "No rule matched.";
  const voters = steps.filter((s) => s.files_in);
  const tagOnly = steps.length - voters.length;
  const chained = steps.filter((s) => s.pass > 1).length;
  return `${steps.length} rule${steps.length === 1 ? "" : "s"} matched (${voters.length} voted for a shelf, ${tagOnly} only added tags` + (chained ? `, ${chained} fired because another rule added a tag` : "") + "); the highest priority vote won.";
}

// src/librarian/repair.ts
function isMissingTable(err) {
  return typeof err === "object" && err !== null && err.code === "42P01";
}
function isPermanent(err) {
  const code = typeof err === "object" && err !== null ? String(err.code ?? "") : "";
  return isMissingTable(err) || /^(22|23|28|42)/.test(code);
}
async function withRetry(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let n = 1; n <= attempts; n++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isPermanent(err) || n === attempts) break;
      opts.onRetry?.(err, n);
      await sleep((opts.baseDelayMs ?? 150) * 2 ** (n - 1));
    }
  }
  throw lastErr;
}
function planBackfill(items, current, book, extraRules = [], forceIds = /* @__PURE__ */ new Set()) {
  const plan = { toWrite: [], examined: items.length, newlyFiled: 0, refiledUnsorted: 0, forced: 0, skipped: 0, stillUnsorted: 0 };
  const filings = classifyBatch(items, book, extraRules);
  for (const f of filings) {
    const id = String(f.itemId);
    const cur = current.get(id);
    if (forceIds.has(id)) {
      plan.toWrite.push(f);
      plan.forced++;
      continue;
    }
    if (cur === void 0) {
      plan.toWrite.push(f);
      plan.newlyFiled++;
      if (f.category === UNSORTED) plan.stillUnsorted++;
      continue;
    }
    if (cur === UNSORTED) {
      if (f.category !== UNSORTED) {
        plan.toWrite.push(f);
        plan.refiledUnsorted++;
      } else plan.stillUnsorted++;
      continue;
    }
    plan.skipped++;
  }
  return plan;
}

// src/server/librarian-store.ts
var ENGINE_VERSION = "librarian-0.3.0";
async function activeRulebook(db) {
  const r = await db.query("SELECT rulebook FROM librarian_settings ORDER BY chosen_at DESC, id DESC LIMIT 1");
  const id = r.rows[0]?.rulebook ?? "preset-d";
  return Object.values(PRESETS).find((b) => b.id === id) ?? PRESETS.D;
}
async function activeExtraRules(db) {
  const r = await db.query("SELECT rule_key, layer, rule_json FROM librarian_active_rules");
  return r.rows.map((x) => ({ ...x.rule_json, id: x.rule_key, layer: x.layer }));
}
async function recordFiling(db, messageId, f, filedBy) {
  await db.query(
    `INSERT INTO memory_filings (message_id, category, tags, shape, source, rulebook, rule_key, explanation, hits, filed_by, engine_ver)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [messageId, f.category, f.tags, f.shape, f.source, f.rulebook, f.winningRule, f.explanation, JSON.stringify(f.hits), filedBy, ENGINE_VERSION]
  );
}
async function fileMessage(db, item, opts = {}) {
  try {
    const f = await withRetry(async () => {
      const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
      const filing = classify(item, book, extra);
      await recordFiling(db, item.id, filing, "librarian");
      return filing;
    }, opts.retry);
    return f;
  } catch (err) {
    (opts.onError ?? ((e, it) => console.error(`[librarian] could not file memory ${it.id}: ${e instanceof Error ? e.message : String(e)}`)))(err, item);
    return null;
  }
}
async function refileUnsorted(db, limit = 200) {
  const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
  const r = await db.query(
    `SELECT m.id, m.text, m.sender, c.name AS conv, (f.message_id IS NULL) AS never_filed
       FROM memory_unsorted u
       JOIN messages m ON m.id = u.message_id
       LEFT JOIN conversations c ON c.uuid = m.conversation_uuid
       LEFT JOIN memory_current_filing f ON f.message_id = m.id
      ORDER BY m.id DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1e3)]
  );
  const items = r.rows.map((x) => ({ id: x.id, text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
  const current = new Map(r.rows.filter((x) => !x.never_filed).map((x) => [String(x.id), UNSORTED]));
  const plan = planBackfill(items, current, book, extra);
  const toWrite = plan.toWrite;
  if (toWrite.length) await recordFilingsBulk(db, toWrite, "backfill");
  return { examined: plan.examined, refiled: toWrite.filter((f) => f.category !== UNSORTED).length, stillUnsorted: plan.stillUnsorted };
}
async function loadItem(db, messageId) {
  const r = await db.query(
    `SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid WHERE m.id = $1`,
    [messageId]
  );
  const x = r.rows[0];
  return x ? { id: x.id, text: x.text ?? "", sender: x.sender, conversationName: x.conv } : null;
}
async function listUnsorted(db, limit = 20) {
  const r = await db.query("SELECT message_id, created_at, preview, why FROM memory_unsorted ORDER BY created_at DESC LIMIT $1", [Math.min(limit, 100)]);
  return r.rows;
}
async function explainFiling(db, messageId) {
  const r = await db.query("SELECT category, tags, rule_key, explanation, hits, filed_by, filed_at FROM memory_current_filing WHERE message_id = $1", [messageId]);
  const row = r.rows[0];
  if (!row) return { category: UNSORTED, explanation: "Not filed yet; it is in the unsorted tray.", matched_rules: [], trail_summary: "No rule matched." };
  const { hits, ...rest } = row;
  const matched_rules = trailOf(hits, row.rule_key, row.category);
  return { ...rest, matched_rules, trail_summary: trailSummary(matched_rules) };
}
async function knownShelves(db, book, extra) {
  const filed = (await db.query("SELECT DISTINCT category FROM memory_current_filing")).rows.map((x) => String(x.category));
  return knownCategories(book, extra, filed);
}
var MAILBOX_MOVE = /^for-[a-z0-9][a-z0-9-]*$/;
async function moveMemory(db, messageId, toCategory, movedBy, opts = {}) {
  const item = await loadItem(db, messageId);
  if (!item) throw new Error(`No memory with id ${messageId}`);
  const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
  const check = checkCategory(toCategory, await knownShelves(db, book, extra), opts.confirmNewCategory === true);
  if (!check.ok) return { moved: false, needs_confirmation: true, did_you_mean: check.didYouMean, note: check.note };
  toCategory = check.slug;
  const before = classify(item, book, extra);
  const ref = (await db.query(
    `SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id DESC LIMIT 500`
  )).rows.map((x) => ({ id: x.id, text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
  const { rule, note } = MAILBOX_MOVE.test(toCategory) || MAILBOX_MOVE.test(before.category) ? { rule: null, note: "Mailbox move recorded; no rule learned (moves into or out of for-<agent> mailboxes never teach the Librarian)." } : learnFromMove(item, toCategory, book, extra, ref);
  if (rule) {
    await db.query(`INSERT INTO librarian_rules (rule_key, layer, rule_json, created_by) VALUES ($1,'learned',$2,$3)`, [rule.id, JSON.stringify(rule), movedBy]);
  }
  await db.query(
    `INSERT INTO memory_moves (message_id, from_category, to_category, learned_rule, moved_by) VALUES ($1,$2,$3,$4,$5)`,
    [messageId, before.category, toCategory, rule?.id ?? null, movedBy]
  );
  const after = classify(item, book, rule ? [...extra, rule] : extra);
  const manualHit = { ruleId: "manual.move", layer: "manual", category: toCategory, priority: 1e4, matched: [`moved by ${movedBy}`], description: `You moved it to "${toCategory}" by hand.` };
  await recordFiling(db, messageId, { ...after, category: toCategory, winningRule: rule?.id ?? null, hits: [manualHit, ...after.hits], explanation: `Moved here by ${movedBy}. ${note}` }, "manual");
  const refile = rule ? await refileUnsorted(db).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })) : void 0;
  return { moved: true, from: before.category, to: toCategory, learned: rule?.id ?? null, note, ...refile ? { refiled_unsorted: refile } : {} };
}
async function nextRuleKey(db) {
  const r = await db.query(`SELECT nextval(pg_get_serial_sequence('librarian_rules','id')) AS n`);
  return `custom.${r.rows[0].n}`;
}
async function addPlainRule(db, sentence, createdBy, opts = {}) {
  const probe = parsePlainRule(sentence, "custom.probe");
  if (!probe) return { ok: false, note: `I could not read that rule. ${PLAIN_RULE_HELP}` };
  const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
  if (probe.category) {
    const check = checkCategory(probe.category, await knownShelves(db, book, extra), opts.confirmNewCategory === true);
    if (!check.ok) return { ok: false, needs_confirmation: true, did_you_mean: check.didYouMean, note: check.note };
    probe.category = check.slug;
  }
  const rule = { ...parsePlainRule(sentence, await nextRuleKey(db)), category: probe.category };
  await db.query(
    `INSERT INTO librarian_rules (rule_key, layer, rule_json, plain_text, created_by) VALUES ($1,'custom',$2,$3,$4)`,
    [rule.id, JSON.stringify(rule), sentence, createdBy]
  );
  const refile = await refileUnsorted(db).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  return { ok: true, rule, refiled_unsorted: refile };
}
var LIBRARIAN_TOOLS = [
  { name: "list_unsorted", scope: "memory.read", description: "List memories in the unsorted tray (nothing the Librarian could file).", inputSchema: { type: "object", properties: { limit: { type: "integer", default: 20 } } } },
  { name: "explain_filing", scope: "memory.read", description: "Say which shelf a memory is on and the exact rule that put it there.", inputSchema: { type: "object", properties: { message_id: { type: "integer" } }, required: ["message_id"] } },
  { name: "move_memory", scope: "memory.write", description: "Move a memory to another shelf. The Librarian may learn a trigger word from the move.", inputSchema: { type: "object", properties: { message_id: { type: "integer" }, to_category: { type: "string" }, source: { type: "string" }, confirm_new_category: { type: "boolean", description: "Set true to create a brand-new shelf; otherwise unknown shelf names are refused." } }, required: ["message_id", "to_category", "source"] } },
  { name: "add_rule", scope: "memory.write", description: 'Add a plain-word filing rule, e.g. "anything mentioning invoices goes in money".', inputSchema: { type: "object", properties: { rule: { type: "string" }, source: { type: "string" }, confirm_new_category: { type: "boolean", description: "Set true to create a brand-new shelf; otherwise unknown shelf names are refused." } }, required: ["rule", "source"] } }
];
async function recordFilingsBulk(db, filings, filedBy) {
  const rows = filings.map((f) => ({ message_id: f.itemId, category: f.category, tags: f.tags, shape: f.shape, source: f.source, rulebook: f.rulebook, rule_key: f.winningRule, explanation: f.explanation, hits: f.hits }));
  await db.query(
    `INSERT INTO memory_filings (message_id, category, tags, shape, source, rulebook, rule_key, explanation, hits, filed_by, engine_ver)
     SELECT (x->>'message_id')::bigint, x->>'category', ARRAY(SELECT jsonb_array_elements_text(x->'tags')), x->>'shape', x->>'source',
            x->>'rulebook', x->>'rule_key', x->>'explanation', x->'hits', $2, $3
       FROM jsonb_array_elements($1::jsonb) AS x`,
    [JSON.stringify(rows), filedBy, ENGINE_VERSION]
  );
}
export {
  ENGINE_VERSION,
  LIBRARIAN_TOOLS,
  activeExtraRules,
  activeRulebook,
  addPlainRule,
  explainFiling,
  fileMessage,
  listUnsorted,
  moveMemory,
  recordFiling,
  recordFilingsBulk,
  refileUnsorted
};
