export const SECRET_PATTERNS = [
  { name: "OpenAI-style API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub classic token", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/g },
  { name: "GitHub OAuth/server/user/refresh token", pattern: /\bgh[osru]_[A-Za-z0-9_]{20,}\b/g },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "Windows user private path", pattern: /[A-Z]:\\Users\\[A-Za-z0-9._-]+/gi },
  { name: "WSL Windows user private path", pattern: /\/mnt\/[a-z]\/Users\/[A-Za-z0-9._-]+/gi },
  { name: "Windows drive private path", pattern: /[A-Z]:\\(?:Users|Documents|Desktop|Downloads)\\/gi }
];

export function scanSensitiveText(text) {
  const findings = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ name, index: match.index ?? 0 });
    }
  }
  return findings;
}
