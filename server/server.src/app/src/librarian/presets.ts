import type { Rule, Rulebook } from './types.js';
import { ENTITY_RULES } from './entities.js';
import { GENERIC_VOCAB, type VocabPack } from './vocab.js';
import { OWNER_VOCAB } from './vocabOwner.js';

/**
 * Setup presets the customer picks at sign-up. Each becomes their rulebook.
 *  A = sort by project      B = sort by kind of work
 *  C = work/personal first, then project      D = all-round default
 * Priority bands: custom/learned 900+, tags 800, project words 500-600, topics 300-400, shape 200, source 100.
 *
 * Presets are built from a word pack (vocab.ts). PRESETS / PRESET_A..D use the GENERIC pack: that is what hosted
 * and new tenants get. OWNER_PRESETS use the owner's pack (vocabOwner.ts) and are only used where selected
 * (presetsFor('owner'), LIBRARIAN_VOCAB=owner on a self-hosted install). Rulebook ids are the same in both.
 */

/** Words that are plainly about money (a narrower list than FINANCE: no price/pricing/revenue/subscription, which are product words). */
const FINANCE_STRICT = ['invoice', 'invoices', 'payment', 'payments', 'paid', 'refund', 'receipt', 'payroll', 'tax', 'taxes', 'irs', 'expense', 'expenses', 'bank', 'loan', 'owe', 'owed', 'dollars', 'budget'];

const allWords = (p: { words: string[]; weak?: string[] }) => [...p.words, ...(p.weak ?? [])];

const tagRule = (cat: string, tags: string[]): Rule => ({
  id: `tag.${cat}`, layer: 'content', when: { tags }, category: cat, priority: 800,
  description: `The writer tagged it ${tags.map((t) => `"${t}"`).join(' or ')}.`,
});

const topic = (id: string, cat: string, words: string[], priority: number, description: string, addTags: string[] = []): Rule => ({
  id, layer: 'content', when: { anyWords: words }, category: cat, priority, description, addTags,
});

/**
 * Infrastructure names that contain a business name without being about that business (preset D).
 * E.g. a database that lives in a cloud project named after one of the businesses.
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

/** Build the four presets from one word pack. */
export function buildPresets(v: VocabPack): Record<'A' | 'B' | 'C' | 'D', Rulebook> {
  const PROJECTS = v.projects;
  const STRONG_WORDS = Object.values(PROJECTS).flatMap((p) => p.words);
  const AI_NICKNAMES = v.aiNicknames;
  const nonEmpty = (r: Rule) => !(r.when.anyWords && r.when.anyWords.length === 0) && !(r.when.conversationWords && r.when.conversationWords.length === 0);

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

  /** Tag-only rules (no category) shared by every preset, so tags stay useful whatever the sort. */
  const sharedTagRules: Rule[] = [
    { id: 'tag-only.money', layer: 'content', when: { anyWords: v.finance }, addTags: ['money'], priority: 50, description: 'Talks about money.' },
    { id: 'tag-only.personal', layer: 'content', when: { anyWords: v.personal }, addTags: ['personal'], priority: 50, description: 'Personal life.' },
    { id: 'tag-only.decision', layer: 'content', when: { anyWords: ['decided', 'decision', 'we will', 'going with'] }, addTags: ['decision'], priority: 50, description: 'Records a decision.' },
  ];

  const projectCats = Object.entries(PROJECTS).map(([slug, p]) => ({ slug, name: p.name }));

  const A: Rulebook = {
    id: 'preset-a',
    name: 'A — By project',
    description: 'Every memory goes in the project it is about. Anything not about a project goes to General, or the unsorted tray.',
    categories: [...projectCats, { slug: 'personal', name: 'Personal' }, { slug: 'general', name: 'General' }],
    rules: ([
      ...Object.keys(PROJECTS).map((slug) => tagRule(slug, [slug, PROJECTS[slug].name])),
      ...projectRules(600),
      ...projectNotebookRules(550),
      topic('content.personal', 'personal', v.personal, 300, 'Personal life, not a project.'),
      { id: 'shape.code.general', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'general', priority: 200, description: 'Technical item with no project named.' },
      ...sharedTagRules,
    ] as Rule[]).filter(nonEmpty),
  };

  const B: Rulebook = {
    id: 'preset-b',
    name: 'B — By kind of work',
    description: 'Sorted by what kind of work it is: code, money, marketing, research, planning, design, personal.',
    categories: [
      { slug: 'code', name: 'Code' }, { slug: 'money', name: 'Money' }, { slug: 'marketing', name: 'Marketing' },
      { slug: 'research', name: 'Research' }, { slug: 'planning', name: 'Planning' }, { slug: 'design', name: 'Design' },
      { slug: 'personal', name: 'Personal' },
    ],
    rules: ([
      tagRule('code', ['code']), tagRule('money', ['money', 'finance']), tagRule('personal', ['personal']),
      { id: 'shape.code', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'code', priority: 450, description: 'It is code, a PR, a commit, or an error.' },
      topic('content.money', 'money', v.finance, 420, 'Talks about money (invoices, payments, pricing, tax).', ['money']),
      topic('content.personal', 'personal', v.personal, 410, 'Personal life.'),
      topic('content.marketing', 'marketing', v.marketing, 400, 'Marketing, social, or outreach.'),
      topic('content.design', 'design', v.design, 390, 'Design or visuals.'),
      topic('content.research', 'research', v.research, 380, 'Research or a comparison.'),
      topic('content.code-words', 'code', v.codeWords, 370, 'Technical words (repo, deploy, database...).'),
      topic('content.planning', 'planning', v.planning, 360, 'A plan, spec, handoff or decision.'),
      ...projectRules(10).map((r) => ({ ...r, category: undefined, id: r.id.replace('content.', 'tag-only.') })),
      ...sharedTagRules,
    ] as Rule[]).filter(nonEmpty),
  };

  const C: Rulebook = {
    id: 'preset-c',
    name: 'C — Work / personal first, then project',
    description: 'Personal life is split off first. Work is then filed by project (work/<project>), or work/general.',
    categories: [
      { slug: 'personal', name: 'Personal' }, { slug: 'personal/money', name: 'Personal money', parent: 'personal' },
      { slug: 'work/general', name: 'Work — general', parent: 'work' },
      ...projectCats.map((c) => ({ slug: `work/${c.slug}`, name: `Work — ${c.name}`, parent: 'work' })),
    ],
    rules: ([
      tagRule('personal', ['personal']),
      { id: 'content.personal', layer: 'content', when: { anyWords: v.personal, noneWords: Object.values(PROJECTS).flatMap(allWords) }, category: 'personal', priority: 700, description: 'Personal life with no project named.' },
      ...projectRules(600, 'work/'),
      ...projectNotebookRules(550, 'work/'),
      { id: 'shape.work', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'work/general', priority: 200, description: 'Technical work with no project named.' },
      topic('content.work-words', 'work/general', [...v.codeWords, ...v.marketing, ...v.finance], 150, 'Work words with no project named.'),
      ...sharedTagRules,
    ] as Rule[]).filter(nonEmpty),
  };

  /** Weak business words file only with product context (preset D). */
  const projectContextRules = (priority: (slug: string) => number): Rule[] =>
    Object.entries(PROJECTS).filter(([, p]) => p.weak?.length).map(([slug, p]) => ({
      id: `content.project-context.${slug}`,
      layer: 'content',
      when: { anyWords: p.weak!, withAny: v.productContext },
      category: slug,
      addTags: [slug],
      priority: priority(slug),
      description: `Talks about ${p.name}'s line of work and about the product or business side of it.`,
    }));

  const jobWords = [...v.jobTalk, ...v.jobWeak];
  const D: Rulebook = {
    id: 'preset-d',
    name: 'D — All-round default',
    description: v.presetDDescription,
    categories: [
      { slug: 'personal', name: 'Personal' }, { slug: 'finance', name: 'Finance' }, { slug: 'code', name: 'Code' },
      { slug: 'business', name: 'Business (general)' }, { slug: 'ai-tools', name: 'AI tools & agents' },
      { slug: 'people', name: 'People' }, { slug: 'places', name: 'Places' }, { slug: 'organizations', name: 'Organizations & customers' },
      ...projectCats.map((c) => ({ ...c, parent: 'business' })),
    ],
    ignore: INFRA_IGNORE,
    rules: ([
      tagRule('personal', ['personal']), tagRule('finance', ['finance', 'money']), tagRule('code', ['code']),
      ...Object.keys(PROJECTS).map((slug) => tagRule(slug, [slug, PROJECTS[slug].name])),
      // Personal beats project only when no business is named.
      { id: 'content.personal', layer: 'content', when: { anyWords: v.personal, noneWords: [...STRONG_WORDS, ...AI_NICKNAMES] }, category: 'personal', priority: 650, description: 'Personal life, no business named.' },
      ...projectRules(600, '', true),
      // A business's product context outranks a notebook name; a business whose weak words are generic trade talk
      // (the owner pack's Forge TMS) sits just below notebooks, so inside another business's conversation it stays put.
      ...projectContextRules((slug) => (slug === 'forge-tms' ? 545 : 590)),
      // Money outranks the day job: "invoice from <a trucking company>" is Finance, not day-job talk. Off when the pack has no day job.
      ...(jobWords.length ? [
        { id: 'content.finance-job', layer: 'content', when: { anyWords: FINANCE_STRICT, withAny: jobWords, noneWords: [...STRONG_WORDS, ...AI_NICKNAMES] }, category: 'finance', priority: 568, description: 'Money (invoice, payment, tax, ...) mixed with day-job words: money outranks the day job.', addTags: ['money', 'job'] } as Rule,
        { id: 'content.job-talk', layer: 'content', when: { shape: ['chat'], anyWords: jobWords, noneWords: [...STRONG_WORDS, ...v.productContext] }, category: 'personal', priority: 560, description: 'Day-job talk, with no business named and nothing about the product.', addTags: ['job'] } as Rule,
      ] : []),
      ...projectNotebookRules(550, '', true),
      topic('content.finance', 'finance', v.finance, 400, 'Money with no business named (invoices, payments, tax).', ['money']),
      { id: 'shape.code', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'code', priority: 200, description: 'It is code, a PR, a commit, or an error, with no business named.' },
      topic('content.code-words', 'code', v.codeWords, 190, 'Technical words, no business named.'),
      topic('content.business', 'business', [...v.marketing, 'customer', 'customers', 'client', 'sales', 'business', 'llc', 'pitch', 'investor', 'investors', 'licensing', 'insurance', 'pilot', 'launch', 'contract'], 180, 'General business, no specific business named.'),
      topic('content.ai-tools', 'ai-tools', v.aiTools, 170, 'About the AI tools themselves (Claude, ChatGPT, agents, handoffs).'),
      ...ENTITY_RULES([...v.aiTools, ...AI_NICKNAMES]),
      ...sharedTagRules,
    ] as Rule[]).filter(nonEmpty),
  };
  return { A, B, C, D };
}

/** Generic presets: hosted and new tenants. */
export const PRESETS: Record<'A' | 'B' | 'C' | 'D', Rulebook> = buildPresets(GENERIC_VOCAB);
export const PRESET_A = PRESETS.A;
export const PRESET_B = PRESETS.B;
export const PRESET_C = PRESETS.C;
export const PRESET_D = PRESETS.D;

/** The owner's presets (vocabOwner.ts). Same rulebook ids; only used where selected. */
export const OWNER_PRESETS: Record<'A' | 'B' | 'C' | 'D', Rulebook> = buildPresets(OWNER_VOCAB);

export const VOCAB_PACKS: Record<string, VocabPack> = { generic: GENERIC_VOCAB, owner: OWNER_VOCAB };

/** Presets for a pack name ('generic' | 'owner'); anything unknown or empty falls back to the given default. */
export function presetsFor(pack: string | undefined | null, fallback: 'generic' | 'owner' = 'generic'): Record<'A' | 'B' | 'C' | 'D', Rulebook> {
  const key = (pack ?? '').trim().toLowerCase();
  const name = key === 'owner' || key === 'generic' ? key : fallback;
  return name === 'owner' ? OWNER_PRESETS : PRESETS;
}

/** The word pack behind a preset family (for display names of business shelves). */
export function vocabFor(pack: string | undefined | null, fallback: 'generic' | 'owner' = 'generic'): VocabPack {
  const key = (pack ?? '').trim().toLowerCase();
  return VOCAB_PACKS[key === 'owner' || key === 'generic' ? key : fallback];
}
