// Shared word lists. Plain data so a customer can read and edit them.
/**
 * Per business: `words` are STRONG names that file on their own; `weak` words only file when the same
 * memory also shows product/business context (PRODUCT_CONTEXT). Presets A-C treat both as triggers.
 */
export const PROJECTS: Record<string, { name: string; words: string[]; weak?: string[] }> = {
  // EXAMPLE — replace with your own businesses and products. Each entry is
  // one shelf: `words` are strong names that file on their own; `weak` words
  // file only when the same memory also shows product context.
  'my-business': { name: 'My Business', words: ['my business', 'my company'] },
  'shared-memory': { name: 'Shared Memory', words: ['shared memory', 'scribe', 'search_memory', 'save_memory', 'librarian', 'beacons'] },
};

/** Words that show a memory is about building/selling a product, not just the work itself. */
export const PRODUCT_CONTEXT = ['app', 'apps', 'apk', 'platform', 'pilot', 'pitch', 'pitching', 'demo', 'investor', 'investors', 'customer', 'customers',
  'geofence', 'geofencing', 'manifest', 'dashboard', 'backend', 'frontend', 'feature', 'features', 'compliance', 'software', 'saas', 'mvp', 'prototype',
  'startup', 'product', 'licensing', 'contract', 'revenue', 'pricing', 'sell', 'selling', 'qr', 'qr code', 'simulation', 'database', 'api', 'repo',
  'deploy', 'app store', 'play store', 'dispatch board', 'auto dispatch', 'driver app', 'samsara', 'integration', 'market', 'competitor', 'competitors',
  'system', 'screen', 'display', 'metric', 'metrics', 'data', 'tracking', 'scan', 'automation', 'workflow', 'endpoint', 'schema', 'ui', 'pitch deck',
  'founder', 'company', 'companies', 'business', 'sales', 'partnership', 'roi', 'traceability', 'audit', 'research', 'spec', 'build', 'built',
  'code', 'coding', 'coded', 'commit', 'commits', 'pushed', 'typecheck', 'wired', 'command', 'commands', 'checklist', 'architecture', 'button', 'buttons',
  'tap', 'photo', 'photos', 'website', 'test', 'tested', 'testing', 'bug', 'bugs', 'fix', 'fixed', 'workflow', 'sync', 'alert', 'alerts', 'stubbed',
  'mock', 'handoff', 'cip', 'sign off', 'voice agent', 'module', 'modules', 'pillar', 'phase', 'milestone', 'version', 'portal', 'vendor', 'vendors',
  'claude', 'grok', 'gpt', 'chatgpt', 'gemini', 'cursor', 'replit', 'linkedin', 'post', 'posts', 'outreach', 'email', 'meeting', 'msa', 'deal',
  'savings', 'per truck', 'per year', 'flow rate', 'flow rates', 'drivers', 'fleet', 'fleets', 'ids', 'pilot program', 'idle time'];

/** The owner's day job. Files to Personal when no product context and no business name. Edit these words to match the job. */
export const JOB_TALK = ['my shift', 'my route', 'clock in', 'clock out', 'overtime', 'paycheck', 'boss', 'supervisor', 'the office', 'on the road',
  'traffic', 'commute', 'meeting ran long', 'deadline', 'shift', 'schedule', 'coworker', 'manager', 'workload', 'break room'];

export const FINANCE = ['invoice', 'invoices', 'payment', 'paid', 'refund', 'stripe', 'bank', 'budget', 'tax', 'taxes', 'irs', 'payroll', 'expense', 'receipt', 'subscription', 'billing', 'price', 'pricing', 'revenue', 'profit', 'loan', 'credit card', 'owe', 'owed', 'paddle', 'lemon squeezy', 'gumroad', 'dollars'];
export const PERSONAL = ['family', 'wife', 'kids', 'son', 'daughter', 'mom', 'dad', 'doctor', 'diabetes', 'insulin', 'blood sugar', 'vet', 'dog', 'birthday', 'church', 'prayer', 'vacation', 'health', 'appointment', 'banner', 'brother', 'sister', 'cousin', 'girlfriend', 'feelings', 'mental', 'stress', 'stressed', 'tired', 'sleep', 'exhausted', 'drive home', 'my life', 'god', 'jesus', 'faith in god', 'carnival'];
export const CODE_WORDS = ['repo', 'github', 'branch', 'deploy', 'vercel', 'docker', 'migration', 'schema', 'typescript', 'javascript', 'python', 'api', 'endpoint', 'bug', 'refactor', 'build', 'pnpm', 'npm', 'postgres', 'neon', 'sql', 'hetzner', 'caddy', 'mcp', 'oauth', 'worktree'];
export const MARKETING = ['linkedin', 'facebook', 'instagram', 'tiktok', 'youtube', 'reel', 'reels', 'newsletter', 'seo', 'outreach', 'campaign', 'landing page', 'waitlist', 'product hunt'];
export const RESEARCH = ['research', 'competitor', 'compare', 'comparison', 'market', 'report', 'study', 'pricing research'];
export const PLANNING = ['plan', 'roadmap', 'todo', 'to-do', 'next step', 'next steps', 'punch list', 'handoff', 'spec', 'decision', 'decided'];
export const DESIGN = ['design', 'mockup', 'logo', 'print file', 'artwork', 'font', 'color', 'screenshot', 'ui', 'ux'];
export const AI_TOOLS = ['claude', 'claude code', 'chatgpt', 'gpt', 'gemini', 'grok', 'jarvis', 'codex', 'cursor', 'muse', 'midjourney', 'llm', 'prompt', 'prompts', 'agent', 'agents', 'subagent', 'voice chat', 'tts', 'elevenlabs', 'handoff', 'context window', '/clear', 'clear command'];
