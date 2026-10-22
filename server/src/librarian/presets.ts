import type { Rule, Rulebook } from './types.ts';
import { CODE_WORDS, DESIGN, FINANCE, MARKETING, PERSONAL, PLANNING, PROJECTS, RESEARCH } from './vocab.ts';

/**
 * Setup presets the customer picks at sign-up. Each becomes their rulebook.
 *  A = sort by project      B = sort by kind of work
 *  C = work/personal first, then project      D = all-round default
 * Priority bands: custom/learned 900+, tags 800, project words 500-600, topics 300-400, shape 200, source 100.
 */

const projectRules = (priority: number, prefix = ''): Rule[] =>
  Object.entries(PROJECTS).map(([slug, p]) => ({
    id: `content.project.${slug}`,
    layer: 'content',
    when: { anyWords: p.words },
    category: `${prefix}${slug}`,
    addTags: [slug],
    priority,
    description: `Mentions ${p.name}.`,
  }));

const projectNotebookRules = (priority: number, prefix = ''): Rule[] =>
  Object.entries(PROJECTS).map(([slug, p]) => ({
    id: `content.notebook.${slug}`,
    layer: 'content',
    when: { conversationWords: p.words },
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
    { id: 'content.personal', layer: 'content', when: { anyWords: PERSONAL, noneWords: Object.values(PROJECTS).flatMap((p) => p.words) }, category: 'personal', priority: 700, description: 'Personal life with no project named.' },
    ...projectRules(600, 'work/'),
    ...projectNotebookRules(550, 'work/'),
    { id: 'shape.work', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'work/general', priority: 200, description: 'Technical work with no project named.' },
    topic('content.work-words', 'work/general', [...CODE_WORDS, ...MARKETING, ...FINANCE], 150, 'Work words with no project named.'),
    ...sharedTagRules,
  ],
};

export const PRESET_D: Rulebook = {
  id: 'preset-d',
  name: 'D — All-round default',
  description: 'Personal, finance, code, and one shelf per business (Faith N Light, Helmian, DairyForge/FirstUse, Forge TMS, ...). Project beats topic; topic beats shape.',
  categories: [
    { slug: 'personal', name: 'Personal' }, { slug: 'finance', name: 'Finance' }, { slug: 'code', name: 'Code' },
    { slug: 'business', name: 'Business (general)' }, ...projectCats.map((c) => ({ ...c, parent: 'business' })),
  ],
  rules: [
    tagRule('personal', ['personal']), tagRule('finance', ['finance', 'money']), tagRule('code', ['code']),
    ...Object.keys(PROJECTS).map((slug) => tagRule(slug, [slug, PROJECTS[slug].name])),
    // Personal beats project only when no business is named.
    { id: 'content.personal', layer: 'content', when: { anyWords: PERSONAL, noneWords: Object.values(PROJECTS).flatMap((p) => p.words) }, category: 'personal', priority: 650, description: 'Personal life, no business named.' },
    ...projectRules(600),
    ...projectNotebookRules(550),
    topic('content.finance', 'finance', FINANCE, 400, 'Money with no business named (invoices, payments, tax).', ['money']),
    { id: 'shape.code', layer: 'shape', when: { shape: ['code', 'pr', 'commit', 'error'] }, category: 'code', priority: 200, description: 'It is code, a PR, a commit, or an error, with no business named.' },
    topic('content.code-words', 'code', CODE_WORDS, 190, 'Technical words, no business named.'),
    topic('content.business', 'business', [...MARKETING, 'customer', 'customers', 'client', 'sales', 'business', 'llc'], 180, 'General business, no specific business named.'),
    ...sharedTagRules,
  ],
};

export const PRESETS: Record<'A' | 'B' | 'C' | 'D', Rulebook> = { A: PRESET_A, B: PRESET_B, C: PRESET_C, D: PRESET_D };
