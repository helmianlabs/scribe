import type { Shape } from './types.ts';

// Deterministic shape detection. Order matters: the most specific shape wins.
const PR = [
  /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i,
  /\bpull request\b/i,
  /\bPR\s*#\d+/,
  /\bmerge(d)? (pr|pull request|branch)\b/i,
];
const COMMIT = [
  /\bcommit\s+[0-9a-f]{7,40}\b/i,
  /\b[0-9a-f]{7,40}\b.*\b(commit(ted)?|pushed)\b/i,
  /\bgit (commit|push|rebase|cherry-pick)\b/i,
  /github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{7,40}/i,
];
const ERROR = [
  /\bTraceback \(most recent call last\)/,
  /^\s*at [\w$.<>]+ \(.+:\d+:\d+\)/m,
  /\b(?:[A-Z]\w*Error|Exception)\b:\s/,
  /\bERR_[A-Z_]+\b/,
  /\b(?:HTTP\s*)?(?:500|502|503|504)\b.*\b(error|failed)\b/i,
  /\bstack trace\b/i,
  /\bsegmentation fault\b/i,
];
const CODE_FENCE = /```[\s\S]*?```/;
const CODE_LINE = /^\s*(?:import |export |const |let |function |def |class |return |if \(|for \(|SELECT |INSERT |CREATE |\}|\{|<\/?\w+[^>]*>)/i;

export function detectShape(text: string): Shape {
  const t = text ?? '';
  if (PR.some((r) => r.test(t))) return 'pr';
  if (COMMIT.some((r) => r.test(t))) return 'commit';
  if (ERROR.some((r) => r.test(t))) return 'error';
  if (CODE_FENCE.test(t)) return 'code';
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length >= 3) {
    const codeish = lines.filter((l) => CODE_LINE.test(l) || /;\s*$/.test(l)).length;
    if (codeish / lines.length >= 0.5) return 'code';
  }
  return 'chat';
}
