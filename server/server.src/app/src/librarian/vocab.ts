// Shared word lists. Plain data so a customer can read and edit them.
/**
 * Per business: `words` are STRONG names that file on their own; `weak` words only file when the same
 * memory also shows product/business context (PRODUCT_CONTEXT). Presets A-C treat both as triggers.
 */
export const PROJECTS: Record<string, { name: string; words: string[]; weak?: string[] }> = {
  'faith-n-light': { name: 'Faith N Light', words: ['faith n light', 'faith and light', 'faith & light', 'faithnlight', 'fnl', 'printify', 'tumbler', 'beanie', 'dad cap', 'kjv', 'scripture', 'meta shop'] },
  helmian: { name: 'Helmian', words: ['helmian', 'helmion', 'helium runner', 'herald', 'bridge device', 'runner box'] },
  'dairyforge-firstuse': {
    name: 'DairyForge / FirstUse',
    words: ['dairyforge', 'dairy forge', 'dairy forage', 'dairy farmers of america', 'firstuse', 'dfa', 'dairyport', 'saadi', 'saudi', 'wash tag', 'pump start', 'gauge app', 'gauge-sandbox', 'milk moovement'],
    // Sam hauls milk for a living: these words are his day job unless the memory is about the product.
    weak: ['dairy co-op', 'co-op', 'milk hauler', 'wash state', 'magic valley', 'dairy', 'milk', 'hauling', 'hauler', 'haulers', 'creamery', 'dairyman', 'dairymen', 'silo', 'silos', 'gallons', 'pump', 'pumping', 'milk pickup', 'wash', 'tanker', 'first use', 'glanbia', 'chobani'],
  },
  'forge-tms': {
    name: 'Forge TMS',
    words: ['forge tms', 'forge-tms', 'cora', 'load board', 'dispatcher', 'route code', 'hos', 'eld', 'fleet fwd', 'mcleod', 'tms'],
    weak: ['freight', 'carrier', 'dispatch', 'loads', 'trucking', 'broker', 'shipper'],
  },
  'shared-memory': { name: 'Shared Memory', words: ['shared memory', 'claude memory', 'claude_memory', 'search_memory', 'save_memory', 'librarian', 'mcp door', 'beacons'] },
  caldmere: { name: 'Caldmere', words: ['caldmere', 'unity', 'blender', 'centaur'] },
  thinkinbuddy: { name: 'Thinkinbuddy', words: ['thinkinbuddy', 'thinking buddy', 'site diary', 'actionable app'] },
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

/** Sam's day job (driving a milk tanker). Files to Personal when no product context and no business name. */
export const JOB_TALK = ['my truck', 'my route', 'my shift', 'my load', 'fueling', 'fuel up', 'the yard', 'unloading', 'unload', 'unloaded', 'loaded',
  'pre trip', 'post trip', 'driving', 'drove', 'on the road', 'clock in', 'clock out', 'highway', 'traffic', 'weigh station', 'scale house', 'trailer',
  'truck', 'trucks', 'diesel', 'chains', 'black ice', 'miles', 'mile marker', 'dock', 'detention', 'layover', 'overtime', 'paycheck', 'boss', 'supervisor'];

export const FINANCE = ['invoice', 'invoices', 'payment', 'paid', 'refund', 'stripe', 'bank', 'budget', 'tax', 'taxes', 'irs', 'payroll', 'expense', 'receipt', 'subscription', 'billing', 'price', 'pricing', 'revenue', 'profit', 'loan', 'credit card', 'owe', 'owed', 'paddle', 'lemon squeezy', 'gumroad', 'dollars'];
export const PERSONAL = ['family', 'wife', 'kids', 'son', 'daughter', 'mom', 'dad', 'doctor', 'diabetes', 'insulin', 'blood sugar', 'vet', 'dog', 'birthday', 'church', 'prayer', 'vacation', 'health', 'appointment', 'banner', 'brother', 'sister', 'cousin', 'girlfriend', 'feelings', 'mental', 'stress', 'stressed', 'tired', 'sleep', 'exhausted', 'drive home', 'my life', 'god', 'jesus', 'faith in god', 'carnival'];
export const CODE_WORDS = ['repo', 'github', 'branch', 'deploy', 'vercel', 'docker', 'migration', 'schema', 'typescript', 'javascript', 'python', 'api', 'endpoint', 'bug', 'refactor', 'build', 'pnpm', 'npm', 'postgres', 'neon', 'sql', 'hetzner', 'caddy', 'mcp', 'oauth', 'worktree'];
export const MARKETING = ['linkedin', 'facebook', 'instagram', 'tiktok', 'youtube', 'reel', 'reels', 'newsletter', 'seo', 'outreach', 'campaign', 'landing page', 'waitlist', 'product hunt'];
export const RESEARCH = ['research', 'competitor', 'compare', 'comparison', 'market', 'report', 'study', 'pricing research'];
export const PLANNING = ['plan', 'roadmap', 'todo', 'to-do', 'next step', 'next steps', 'punch list', 'handoff', 'spec', 'decision', 'decided'];
export const DESIGN = ['design', 'mockup', 'logo', 'print file', 'artwork', 'font', 'color', 'screenshot', 'ui', 'ux'];
export const AI_TOOLS = ['claude', 'claude code', 'chatgpt', 'gpt', 'gemini', 'grok', 'jarvis', 'codex', 'cursor', 'muse', 'midjourney', 'llm', 'prompt', 'prompts', 'agent', 'agents', 'subagent', 'voice chat', 'tts', 'elevenlabs', 'handoff', 'context window', '/clear', 'clear command'];
