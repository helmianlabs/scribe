import type { Rule, Rulebook } from './types.js';
import { ENTITY_RULES } from './entities.js';
import { AI_TOOLS, CODE_WORDS, DESIGN, FINANCE, JOB_TALK, MARKETING, PERSONAL, PLANNING, PRODUCT_CONTEXT, PROJECTS, RESEARCH } from './vocab.js';

/**
 * Setup presets the customer picks at sign-up. Each becomes their rulebook.
 *  A = sort by project      B = sort by kind of work
 *  C = work/personal first, then project      D = all-round default
 * Priority bands: custom/learned 900+, tags 800, project words 500-600, topics 300-400, shape 200, source 100.
 */

const allWords = (p: { words: string[]; weak?: string[] }) => [...p.words, ...(p.weak ?? [])];
const STRONG_WORDS = Object.values(PROJECTS).flatMap((p) => p.words);
/** Business words that are also plain day-job talk (equipment and product words like silo, pump, wash stay out). */
const JOB_WEAK = ['milk', 'hauling', 'hauler', 'haulers', 'milk hauler', 'milk pickup', 'tanker', 'dairy', 'dairyman', 'dairymen', 'freight', 'loads', 'trucking', 'dispatch'];
/** Words that are plainly about money (a narrower list than FINANCE: no price/pricing/revenue/subscription, which are product words). */
const FINANCE_STRICT = ['invoice', 'invoices', 'payment', 'payments', 'paid', 'refund', 'receipt', 'payroll', 'tax', 'taxes', 'irs', 'expense', 'expenses', 'bank', 'loan', 'owe', 'owed', 'dollars', 'budget'];
/** Sam's names for his AI helpers; "Big Sister" is Claude, not family. */
const AI_NICKNAMES = ['big sister', 'big brother', 'big brother claude', 'big sister claude'];

/** strongOnly=false (presets A-C): strong and weak words both file. Preset D uses strong only here. */
const projectRules = (priority: number, prefix = '', strongOnly = false): Rule[] =>
  Object.entries(PROJECTS).map(([slug, p]) => ({
    id: `content.project.${slug}`,
    layer: 'content',
    when: { anyWords: strongOnly ? p.words : allWords(p) },
    category: `${prefix}${slug}`,
    addTags: [slug],
    priority,
    description: `Mentions ${p.name}.`,
  }));

const projectNotebookRules = (priority: number, prefix = '', strongOnly = false): Rule[] =>
  Object.entries(PROJECTS).map(([slug, p]) => ({
    id: `content.notebook.${slug}`,
    layer: 'content',
    when: { conversationWords: strongOnly ? p.words : allWords(p) },
    category: `${prefix}${slug}`,
    addTags: [slug],
    priority,
    description: `The conversation it came from is about ${p.name}.`,
  }));

const tagRule = (cat: string, tags: string[]): Rule => ({
  id: `tag.${cat}`, layer: 'content', when: { tags }, category: cat, priority: 800,
  description: `The writer tagged it ${tags.map((t) => `"${t}"`).join(' or ')}.`,
});

const topic = (id: string, cat: string, words: string[], priority: number, description: string, addTags: string[] = []): Rule => ({
  id, layer: 'content', when: { anyWords: words }, category: cat, priority, description, addTags,
});

/** Tag-only rules (no category) shared by every preset, so tags stay useful whatever the sort. */
const sharedTagRules: Rule[] = [
  { id: 'tag-only.money', layer: 'content', when: { anyWords: FINANCE }, addTags: ['money'], priority: 50, description: 'Talks about money.' },
  { id: 'tag-only.personal', layer: 'content', when: { anyWords: PERSONAL }, addTags: ['personal'], priority: 50, description: 'Personal life.' },
  { id: 'tag-only.decision', layer: 'content', when: { anyWords: ['decided', 'decision', 'we will', 'going with'] }, addTags: ['decision'], priority: 50, description: 'Records a decision.' },
];

const projectCats = Object.entries(PROJECTS).map(([slug, p]) => ({ slug, name: p.name }));

export const PRESET_A: Rulebook = {
  id: 'preset-a',
  name: 'A — By project',
  description: 'Every memory goes in the project it is about. Anything not about a project goes to General, or the unsorted tray.',
  categories: [...projectCats, { slug: 'personal', name: 'Personal' }, { slug: 'general', name: 'General' }],
  rules: [
    ...Object.keys(PROJECTS).map((slug) => tagRule(slug, [slug, PROJECTS[slug].name])),
    ...projectRules(600),
    ...projectNotebookRules(550),
    topic('content.personal', 'personal', PERSONAL, 300, 'Personal life, not a project.'),
    { id: 'shape.code.general', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'general', priority: 200, description: 'Technical item with no project named.' },
    ...sharedTagRules,
  ],
};

export const PRESET_B: Rulebook = {
  id: 'preset-b',
  name: 'B — By kind of work',
  description: 'Sorted by what kind of work it is: code, money, marketing, research, planning, design, personal.',
  categories: [
    { slug: 'code', name: 'Code' }, { slug: 'money', name: 'Money' }, { slug: 'marketing', name: 'Marketing' },
    { slug: 'research', name: 'Research' }, { slug: 'planning', name: 'Planning' }, { slug: 'design', name: 'Design' },
    { slug: 'personal', name: 'Personal' },
  ],
  rules: [
    tagRule('code', ['code']), tagRule('money', ['money', 'finance']), tagRule('personal', ['personal']),
    { id: 'shape.code', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'code', priority: 450, description: 'It is code, a PR, a commit, or an error.' },
    topic('content.money', 'money', FINANCE, 420, 'Talks about money (invoices, payments, pricing, tax).', ['money']),
    topic('content.personal', 'personal', PERSONAL, 410, 'Personal life.'),
    topic('content.marketing', 'marketing', MARKETING, 400, 'Marketing, social, or outreach.'),
    topic('content.design', 'design', DESIGN, 390, 'Design or visuals.'),
    topic('content.research', 'research', RESEARCH, 380, 'Research or a comparison.'),
    topic('content.code-words', 'code', CODE_WORDS, 370, 'Technical words (repo, deploy, database...).'),
    topic('content.planning', 'planning', PLANNING, 360, 'A plan, spec, handoff or decision.'),
    ...projectRules(10).map((r) => ({ ...r, category: undefined, id: r.id.replace('content.', 'tag-only.') })),
    ...sharedTagRules,
  ],
};

export const PRESET_C: Rulebook = {
  id: 'preset-c',
  name: 'C — Work / personal first, then project',
  description: 'Personal life is split off first. Work is then filed by project (work/<project>), or work/general.',
  categories: [
    { slug: 'personal', name: 'Personal' }, { slug: 'personal/money', name: 'Personal money', parent: 'personal' },
    { slug: 'work/general', name: 'Work — general', parent: 'work' },
    ...projectCats.map((c) => ({ slug: `work/${c.slug}`, name: `Work — ${c.name}`, parent: 'work' })),
  ],
  rules: [
    tagRule('personal', ['personal']),
    { id: 'content.personal', layer: 'content', when: { anyWords: PERSONAL, noneWords: Object.values(PROJECTS).flatMap(allWords) }, category: 'personal', priority: 700, description: 'Personal life with no project named.' },
    ...projectRules(600, 'work/'),
    ...projectNotebookRules(550, 'work/'),
    { id: 'shape.work', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'work/general', priority: 200, description: 'Technical work with no project named.' },
    topic('content.work-words', 'work/general', [...CODE_WORDS, ...MARKETING, ...FINANCE], 150, 'Work words with no project named.'),
    ...sharedTagRules,
  ],
};

/** Weak business words file only with product context (preset D). */
const projectContextRules = (priority: (slug: string) => number): Rule[] =>
  Object.entries(PROJECTS).filter(([, p]) => p.weak?.length).map(([slug, p]) => ({
    id: `content.project-context.${slug}`,
    layer: 'content',
    when: { anyWords: p.weak!, withAny: PRODUCT_CONTEXT },
    category: slug,
    addTags: [slug],
    priority: priority(slug),
    description: `Talks about ${p.name}'s line of work and about the product or business side of it.`,
  }));

/**
 * Infrastructure names that contain a business name without being about that business (preset D).
 * E.g. the shared-memory database lives in a Neon project called "dairyforge" (<NEON_PROJECT_ID>).
 */
const INFRA_IGNORE: { pattern: string; why: string }[] = [
  { pattern: String.raw`\b(?:https?|postgres(?:ql)?|ssh|git)://\S+`, why: 'URLs and connection strings.' },
  { pattern: String.raw`\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+`, why: 'Email addresses and user@host logins.' },
  { pattern: String.raw`(?<![\w/])[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|app|dev|ai|co|shop|sh|cloud|me|xyz|tech)\b(?:/\S*)?`, why: 'Hostnames and domains.' },
  { pattern: String.raw`(?<![\w])(?:~|\.{1,2})?(?:/[\w.@-]+){2,}/?`, why: 'File paths.' },
  { pattern: String.raw`\bneon\s+(?:project|db|database)\s*[:=]?\s*["'\u0060]?[\w-]+["'\u0060]?`, why: 'Neon project names.' },
  { pattern: String.raw`["'\u0060]?[\w-]+["'\u0060]?\s*\(\s*[a-z]+-[a-z]+-\d{6,}\s*\)`, why: 'A Neon project name with its id.' },
  { pattern: String.raw`\b(?:[a-z]+-[a-z]+)-\d{6,}\b`, why: 'Cloud project ids like misty-lake-10000001.' },
  { pattern: String.raw`\b(?:project|database|db|bucket|container|image|branch|schema)\s*[:=]\s*["'\u0060]?[\w-]+["'\u0060]?`, why: 'key=value infra settings.' },
];

export const PRESET_D: Rulebook = {
  id: 'preset-d',
  name: 'D — All-round default',
  description: 'Personal, finance, code, and one shelf per business (Faith N Light, Helmian, DairyForge/FirstUse, Forge TMS, ...). A business name files on its own; its everyday work words (milk, hauling, loads, dispatch) need product context too, otherwise driving and hauling talk is Personal. Infrastructure names (hosts, paths, Neon project ids) are ignored.',
  categories: [
    { slug: 'personal', name: 'Personal' }, { slug: 'finance', name: 'Finance' }, { slug: 'code', name: 'Code' },
    { slug: 'business', name: 'Business (general)' }, { slug: 'ai-tools', name: 'AI tools & agents' },
    { slug: 'people', name: 'People' }, { slug: 'places', name: 'Places' }, { slug: 'organizations', name: 'Organizations & customers' },
    ...projectCats.map((c) => ({ ...c, parent: 'business' })),
  ],
  ignore: INFRA_IGNORE,
  rules: [
    tagRule('personal', ['personal']), tagRule('finance', ['finance', 'money']), tagRule('code', ['code']),
    ...Object.keys(PROJECTS).map((slug) => tagRule(slug, [slug, PROJECTS[slug].name])),
    // Personal beats project only when no business is named.
    { id: 'content.personal', layer: 'content', when: { anyWords: PERSONAL, noneWords: [...STRONG_WORDS, ...AI_NICKNAMES] }, category: 'personal', priority: 650, description: 'Personal life, no business named.' },
    ...projectRules(600, '', true),
    // DairyForge's product context outranks a notebook name; generic trucking-product talk (Forge TMS) sits just
    // below notebooks, so inside a DairyForge conversation it stays DairyForge.
    ...projectContextRules((slug) => (slug === 'forge-tms' ? 545 : 590)),
    // Money outranks the day job: "invoice from <a trucking company>" is Finance, not hauling talk.
    { id: 'content.finance-job', layer: 'content', when: { anyWords: FINANCE_STRICT, withAny: [...JOB_TALK, ...JOB_WEAK], noneWords: [...STRONG_WORDS, ...AI_NICKNAMES] }, category: 'finance', priority: 568, description: 'Money (invoice, payment, tax, ...) mixed with day-job words: money outranks the day job.', addTags: ['money', 'job'] },
    { id: 'content.job-talk', layer: 'content', when: { shape: ['chat'], anyWords: [...JOB_TALK, ...JOB_WEAK], noneWords: [...STRONG_WORDS, ...PRODUCT_CONTEXT] }, category: 'personal', priority: 560, description: 'Driving and hauling talk (the day job), with no business named and nothing about the product.', addTags: ['job'] },
    ...projectNotebookRules(550, '', true),
    topic('content.finance', 'finance', FINANCE, 400, 'Money with no business named (invoices, payments, tax).', ['money']),
    { id: 'shape.code', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'code', priority: 200, description: 'It is code, a PR, a commit, or an error, with no business named.' },
    topic('content.code-words', 'code', CODE_WORDS, 190, 'Technical words, no business named.'),
    topic('content.business', 'business', [...MARKETING, 'customer', 'customers', 'client', 'sales', 'business', 'llc', 'pitch', 'investor', 'investors', 'licensing', 'insurance', 'pilot', 'launch', 'contract'], 180, 'General business, no specific business named.'),
    topic('content.ai-tools', 'ai-tools', AI_TOOLS, 170, 'About the AI tools themselves (Claude, ChatGPT, agents, handoffs).'),
    ...ENTITY_RULES([...AI_TOOLS, ...AI_NICKNAMES]),
    ...sharedTagRules,
  ],
};

export const PRESETS: Record<'A' | 'B' | 'C' | 'D', Rulebook> = { A: PRESET_A, B: PRESET_B, C: PRESET_C, D: PRESET_D };
