// Shared word lists. Plain data so a customer can read and edit them.
// These are the GENERIC defaults every hosted and new tenant starts with: no business shelves, no personal names,
// no one's day job. A tenant adds its own shelves by teaching (add_rule, move_memory). The original owner's pack
// lives in vocabOwner.ts and is only used where it is selected explicitly (see presets.ts presetsFor).

/** A complete word pack. Presets are built from one (presets.ts buildPresets). */
export interface VocabPack {
  id: string;
  /**
   * Per business: `words` are STRONG names that file on their own; `weak` words only file when the same
   * memory also shows product/business context (productContext). Presets A-C treat both as triggers.
   */
  projects: Record<string, { name: string; words: string[]; weak?: string[] }>;
  /** Words that show a memory is about building/selling a product, not just the work itself. */
  productContext: string[];
  /** The writer's day-job talk: files to Personal when no product context and no business name (preset D). Empty = off. */
  jobTalk: string[];
  /** Business words that are also plain day-job talk. Empty = off. */
  jobWeak: string[];
  /** The writer's nicknames for AI helpers (so "big sister" is not family). */
  aiNicknames: string[];
  finance: string[];
  personal: string[];
  codeWords: string[];
  marketing: string[];
  research: string[];
  planning: string[];
  design: string[];
  aiTools: string[];
  presetDDescription: string;
}

export const PROJECTS: VocabPack['projects'] = {};

export const PRODUCT_CONTEXT = ['app', 'apps', 'platform', 'pilot', 'pitch', 'demo', 'investor', 'investors', 'customer', 'customers',
  'dashboard', 'backend', 'frontend', 'feature', 'features', 'software', 'saas', 'mvp', 'prototype', 'startup', 'product', 'licensing',
  'contract', 'revenue', 'pricing', 'sell', 'selling', 'database', 'api', 'repo', 'deploy', 'app store', 'play store', 'integration',
  'market', 'competitor', 'competitors', 'metrics', 'automation', 'workflow', 'endpoint', 'schema', 'ui', 'pitch deck', 'founder',
  'company', 'business', 'sales', 'partnership', 'roi', 'spec', 'code', 'commit', 'website', 'test', 'bug', 'fix', 'release', 'version', 'vendor'];

export const FINANCE = ['invoice', 'invoices', 'payment', 'paid', 'refund', 'stripe', 'bank', 'budget', 'tax', 'taxes', 'irs', 'payroll', 'expense', 'receipt', 'subscription', 'billing', 'price', 'pricing', 'revenue', 'profit', 'loan', 'credit card', 'owe', 'owed', 'paddle', 'lemon squeezy', 'gumroad', 'dollars'];
export const PERSONAL = ['family', 'wife', 'husband', 'partner', 'kids', 'son', 'daughter', 'mom', 'dad', 'parents', 'doctor', 'dentist', 'vet', 'dog', 'cat', 'birthday', 'anniversary', 'wedding', 'vacation', 'holiday', 'health', 'appointment', 'brother', 'sister', 'cousin', 'girlfriend', 'boyfriend', 'feelings', 'stress', 'stressed', 'tired', 'sleep', 'exhausted', 'my life', 'groceries'];
export const CODE_WORDS = ['repo', 'github', 'branch', 'deploy', 'vercel', 'docker', 'migration', 'schema', 'typescript', 'javascript', 'python', 'api', 'endpoint', 'bug', 'refactor', 'build', 'pnpm', 'npm', 'postgres', 'neon', 'sql', 'mcp', 'oauth', 'worktree'];
export const MARKETING = ['linkedin', 'facebook', 'instagram', 'tiktok', 'youtube', 'reel', 'reels', 'newsletter', 'seo', 'outreach', 'campaign', 'landing page', 'waitlist', 'product hunt'];
export const RESEARCH = ['research', 'competitor', 'compare', 'comparison', 'market', 'report', 'study', 'pricing research'];
export const PLANNING = ['plan', 'roadmap', 'todo', 'to-do', 'next step', 'next steps', 'punch list', 'handoff', 'spec', 'decision', 'decided'];
export const DESIGN = ['design', 'mockup', 'logo', 'print file', 'artwork', 'font', 'color', 'screenshot', 'ui', 'ux'];
export const AI_TOOLS = ['claude', 'claude code', 'chatgpt', 'gpt', 'gemini', 'grok', 'codex', 'cursor', 'midjourney', 'llm', 'prompt', 'prompts', 'agent', 'agents', 'subagent', 'voice chat', 'tts', 'elevenlabs', 'handoff', 'context window'];

export const GENERIC_VOCAB: VocabPack = {
  id: 'generic',
  projects: PROJECTS, productContext: PRODUCT_CONTEXT, jobTalk: [], jobWeak: [], aiNicknames: [],
  finance: FINANCE, personal: PERSONAL, codeWords: CODE_WORDS, marketing: MARKETING, research: RESEARCH, planning: PLANNING, design: DESIGN, aiTools: AI_TOOLS,
  presetDDescription: 'Personal, finance, code, general business, AI tools, people, places and organisations. Add a shelf for each of your own businesses or projects by teaching it (add_rule "anything about Acme goes to acme", or move a memory). Infrastructure names (hosts, paths, cloud project ids) are ignored.',
};
