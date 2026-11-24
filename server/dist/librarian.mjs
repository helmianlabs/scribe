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
var LAYER_RANK = { learned: 5, custom: 4, content: 3, shape: 2, source: 1 };
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
    const hit = w.tags.find((t) => ctx.tags.includes(normalise(t)));
    if (!hit) return null;
    matched.push(`tag "${normalise(hit)}"`);
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
  if (w.noneWords?.length) {
    if (findWords(ctx.text, w.noneWords).length) return null;
  }
  return conditions > 0 ? matched : null;
}
function sortRules(rules) {
  return [...rules].sort(
    (a, b) => b.priority - a.priority || LAYER_RANK[b.layer] - LAYER_RANK[a.layer] || a.id.localeCompare(b.id)
  );
}
function classify(item, book, extraRules = []) {
  const raw = item.text ?? "";
  const tags = parseTags(raw);
  const text = stripTagLine(raw);
  const source = resolveSource(item);
  const shape = detectShape(text);
  const conv = notebookLabel(item.conversationName) ?? item.conversationName ?? "";
  const ctx = { text, source, shape, tags, conv };
  const hits = [];
  for (const rule2 of sortRules([...book.rules, ...extraRules])) {
    const matched = evaluateRule(rule2, ctx);
    if (matched) hits.push({ ruleId: rule2.id, layer: rule2.layer, category: rule2.category, priority: rule2.priority, matched });
  }
  const allRules = new Map([...book.rules, ...extraRules].map((r) => [r.id, r]));
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
  return {
    itemId: item.id,
    category: winner.category,
    tags: [...outTags].sort(),
    rulebook: book.id,
    winningRule: winner.ruleId,
    hits,
    shape,
    source,
    explanation: `Filed in "${winner.category}" by rule ${winner.ruleId} (${winner.layer} layer): ${rule.description} Matched ${winner.matched.join(", ")}.`
  };
}

// src/librarian/vocab.ts
var PROJECTS = {
  "faith-n-light": { name: "Faith N Light", words: ["faith n light", "faith and light", "faith & light", "faithnlight", "fnl", "printify", "tumbler", "beanie", "dad cap", "kjv", "scripture", "meta shop"] },
  helmian: { name: "Helmian", words: ["helmian", "helmion", "helium runner", "herald", "bridge device", "runner box"] },
  "dairyforge-firstuse": { name: "DairyForge / FirstUse", words: ["dairyforge", "dairy forge", "firstuse", "first use", "dairy co-op", "co-op", "milk hauler", "wash state", "pump start", "magic valley", "dfa", "dairyport", "dairy", "milk", "hauling", "hauler", "haulers", "saadi", "saudi", "creamery", "dairyman", "dairymen", "silo", "silos", "gallons", "pump", "pumping", "milk pickup", "wash", "tanker"] },
  "forge-tms": { name: "Forge TMS", words: ["forge tms", "forge-tms", "cora", "load board", "dispatcher", "route code", "freight", "carrier", "hos", "eld", "fleet fwd", "mcleod", "tms", "dispatch", "load board", "loads", "trucking", "broker", "shipper"] },
  "shared-memory": { name: "Shared Memory", words: ["shared memory", "claude memory", "claude_memory", "search_memory", "save_memory", "librarian", "mcp door", "beacons"] },
  caldmere: { name: "Caldmere", words: ["caldmere", "unity", "blender", "centaur"] },
  thinkinbuddy: { name: "Thinkinbuddy", words: ["thinkinbuddy", "thinking buddy", "site diary", "actionable app"] }
};
var FINANCE = ["invoice", "invoices", "payment", "paid", "refund", "stripe", "bank", "budget", "tax", "taxes", "irs", "payroll", "expense", "receipt", "subscription", "billing", "price", "pricing", "revenue", "profit", "loan", "credit card", "owe", "owed", "paddle", "lemon squeezy", "gumroad", "dollars"];
var PERSONAL = ["family", "wife", "kids", "son", "daughter", "mom", "dad", "doctor", "diabetes", "insulin", "blood sugar", "vet", "dog", "birthday", "church", "prayer", "vacation", "health", "appointment", "banner", "brother", "sister", "cousin", "girlfriend", "feelings", "mental", "stress", "stressed", "tired", "sleep", "exhausted", "drive home", "my life", "god", "jesus", "faith in god", "carnival"];
var CODE_WORDS = ["repo", "github", "branch", "deploy", "vercel", "docker", "migration", "schema", "typescript", "javascript", "python", "api", "endpoint", "bug", "refactor", "build", "pnpm", "npm", "postgres", "neon", "sql", "hetzner", "caddy", "mcp", "oauth", "worktree"];
var MARKETING = ["linkedin", "facebook", "instagram", "tiktok", "youtube", "reel", "reels", "newsletter", "seo", "outreach", "campaign", "landing page", "waitlist", "product hunt"];
var RESEARCH = ["research", "competitor", "compare", "comparison", "market", "report", "study", "pricing research"];
var PLANNING = ["plan", "roadmap", "todo", "to-do", "next step", "next steps", "punch list", "handoff", "spec", "decision", "decided"];
var DESIGN = ["design", "mockup", "logo", "print file", "artwork", "font", "color", "screenshot", "ui", "ux"];
var AI_TOOLS = ["claude", "claude code", "chatgpt", "gpt", "gemini", "grok", "jarvis", "codex", "cursor", "muse", "midjourney", "llm", "prompt", "prompts", "agent", "agents", "subagent", "voice chat", "tts", "elevenlabs", "handoff", "context window", "/clear", "clear command"];

// src/librarian/presets.ts
var projectRules = (priority, prefix = "") => Object.entries(PROJECTS).map(([slug2, p]) => ({
  id: `content.project.${slug2}`,
  layer: "content",
  when: { anyWords: p.words },
  category: `${prefix}${slug2}`,
  addTags: [slug2],
  priority,
  description: `Mentions ${p.name}.`
}));
var projectNotebookRules = (priority, prefix = "") => Object.entries(PROJECTS).map(([slug2, p]) => ({
  id: `content.notebook.${slug2}`,
  layer: "content",
  when: { conversationWords: p.words },
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
    { id: "content.personal", layer: "content", when: { anyWords: PERSONAL, noneWords: Object.values(PROJECTS).flatMap((p) => p.words) }, category: "personal", priority: 700, description: "Personal life with no project named." },
    ...projectRules(600, "work/"),
    ...projectNotebookRules(550, "work/"),
    { id: "shape.work", layer: "shape", when: { shape: ["code", "pr", "commit", "error"] }, category: "work/general", priority: 200, description: "Technical work with no project named." },
    topic("content.work-words", "work/general", [...CODE_WORDS, ...MARKETING, ...FINANCE], 150, "Work words with no project named."),
    ...sharedTagRules
  ]
};
var PRESET_D = {
  id: "preset-d",
  name: "D \u2014 All-round default",
  description: "Personal, finance, code, and one shelf per business (Faith N Light, Helmian, DairyForge/FirstUse, Forge TMS, ...). Project beats topic; topic beats shape.",
  categories: [
    { slug: "personal", name: "Personal" },
    { slug: "finance", name: "Finance" },
    { slug: "code", name: "Code" },
    { slug: "business", name: "Business (general)" },
    { slug: "ai-tools", name: "AI tools & agents" },
    ...projectCats.map((c) => ({ ...c, parent: "business" }))
  ],
  rules: [
    tagRule("personal", ["personal"]),
    tagRule("finance", ["finance", "money"]),
    tagRule("code", ["code"]),
    ...Object.keys(PROJECTS).map((slug2) => tagRule(slug2, [slug2, PROJECTS[slug2].name])),
    // Personal beats project only when no business is named.
    { id: "content.personal", layer: "content", when: { anyWords: PERSONAL, noneWords: Object.values(PROJECTS).flatMap((p) => p.words) }, category: "personal", priority: 650, description: "Personal life, no business named." },
    ...projectRules(600),
    ...projectNotebookRules(550),
    topic("content.finance", "finance", FINANCE, 400, "Money with no business named (invoices, payments, tax).", ["money"]),
    { id: "shape.code", layer: "shape", when: { shape: ["code", "pr", "commit", "error"] }, category: "code", priority: 200, description: "It is code, a PR, a commit, or an error, with no business named." },
    topic("content.code-words", "code", CODE_WORDS, 190, "Technical words, no business named."),
    topic("content.business", "business", [...MARKETING, "customer", "customers", "client", "sales", "business", "llc", "pitch", "investor", "investors", "licensing", "insurance", "pilot", "launch", "contract"], 180, "General business, no specific business named."),
    topic("content.ai-tools", "ai-tools", AI_TOOLS, 170, "About the AI tools themselves (Claude, ChatGPT, agents, handoffs)."),
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
function parsePlainRule(sentence, id, priority = 900) {
  let s = sentence.trim().replace(/\.$/, "");
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
  let m = /^anything (?:mentioning|about|that mentions|with)\s+(.+)$/i.exec(lhs);
  if (m) {
    const body = m[1];
    if (/\s+and\s+/i.test(body)) return { ...base, when: { allWords: body.split(/\s+and\s+/i).map(unquote) } };
    return { ...base, when: { anyWords: body.split(/\s*,\s*|\s+or\s+/i).map(unquote).filter(Boolean) } };
  }
  m = /^anything (?:from|written by|saved by)\s+(.+)$/i.exec(lhs);
  if (m) return { ...base, when: { source: m[1].split(/\s*,\s*|\s+or\s+/i).map(unquote) } };
  m = /^anything tagged\s+(.+)$/i.exec(lhs);
  if (m) return { ...base, when: { tags: m[1].split(/\s*,\s*|\s+or\s+/i).map(unquote) } };
  const shapes = lhs.toLowerCase().replace(/^(all|any)\s+/, "").split(/\s*,\s*|\s+(?:and|or)\s+/).map((x) => SHAPES[x.trim()]);
  if (shapes.length && shapes.every(Boolean)) return { ...base, layer: "custom", when: { shape: shapes } };
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
    const collisions = reference.filter((r) => r.id !== item.id && findWords(stripTagLine(r.text), [word]).length && classify(r, book, existing).category !== toCategory).length;
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

// src/server/librarian-store.ts
var ENGINE_VERSION = "librarian-0.1.0";
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
async function fileMessage(db, item) {
  try {
    const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
    const f = classify(item, book, extra);
    await recordFiling(db, item.id, f, "librarian");
    return f;
  } catch {
    return null;
  }
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
  const r = await db.query("SELECT category, tags, rule_key, explanation, filed_by, filed_at FROM memory_current_filing WHERE message_id = $1", [messageId]);
  return r.rows[0] ?? { category: "unsorted", explanation: "Not filed yet; it is in the unsorted tray." };
}
async function moveMemory(db, messageId, toCategory, movedBy) {
  const item = await loadItem(db, messageId);
  if (!item) throw new Error(`No memory with id ${messageId}`);
  const [book, extra] = await Promise.all([activeRulebook(db), activeExtraRules(db)]);
  const before = classify(item, book, extra);
  const ref = (await db.query(
    `SELECT m.id, m.text, m.sender, c.name AS conv FROM messages m LEFT JOIN conversations c ON c.uuid = m.conversation_uuid ORDER BY m.id DESC LIMIT 500`
  )).rows.map((x) => ({ id: x.id, text: x.text ?? "", sender: x.sender, conversationName: x.conv }));
  const { rule, note } = learnFromMove(item, toCategory, book, extra, ref);
  if (rule) {
    await db.query(`INSERT INTO librarian_rules (rule_key, layer, rule_json, created_by) VALUES ($1,'learned',$2,$3)`, [rule.id, JSON.stringify(rule), movedBy]);
  }
  await db.query(
    `INSERT INTO memory_moves (message_id, from_category, to_category, learned_rule, moved_by) VALUES ($1,$2,$3,$4,$5)`,
    [messageId, before.category, toCategory, rule?.id ?? null, movedBy]
  );
  await recordFiling(db, messageId, { ...before, category: toCategory, winningRule: rule?.id ?? null, explanation: `Moved here by ${movedBy}. ${note}` }, "manual");
  return { from: before.category, to: toCategory, learned: rule?.id ?? null, note };
}
async function addPlainRule(db, sentence, createdBy) {
  const n = (await db.query("SELECT count(*)::int n FROM librarian_rules WHERE layer = $1", ["custom"])).rows[0].n;
  const rule = parsePlainRule(sentence, `custom.${n + 1}`);
  if (!rule) return { ok: false, note: 'I could not read that rule. Try: "anything mentioning X goes in Y".' };
  await db.query(
    `INSERT INTO librarian_rules (rule_key, layer, rule_json, plain_text, created_by) VALUES ($1,'custom',$2,$3,$4)`,
    [rule.id, JSON.stringify(rule), sentence, createdBy]
  );
  return { ok: true, rule };
}
var LIBRARIAN_TOOLS = [
  { name: "list_unsorted", scope: "memory.read", description: "List memories in the unsorted tray (nothing the Librarian could file).", inputSchema: { type: "object", properties: { limit: { type: "integer", default: 20 } } } },
  { name: "explain_filing", scope: "memory.read", description: "Say which shelf a memory is on and the exact rule that put it there.", inputSchema: { type: "object", properties: { message_id: { type: "integer" } }, required: ["message_id"] } },
  { name: "move_memory", scope: "memory.write", description: "Move a memory to another shelf. The Librarian may learn a trigger word from the move.", inputSchema: { type: "object", properties: { message_id: { type: "integer" }, to_category: { type: "string" }, source: { type: "string" } }, required: ["message_id", "to_category", "source"] } },
  { name: "add_rule", scope: "memory.write", description: 'Add a plain-word filing rule, e.g. "anything mentioning invoices goes in money".', inputSchema: { type: "object", properties: { rule: { type: "string" }, source: { type: "string" } }, required: ["rule", "source"] } }
];
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
  recordFiling
};
