import { execFileSync } from "node:child_process";
import fs from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !file.startsWith(".output/") && !file.startsWith("node_modules/"));

const patterns = [
  { name: "OpenAI-style API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub classic token", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/g },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Windows user private path", pattern: /C:\\Users\\[A-Za-z0-9._-]+/g }
];

const findings = [];

for (const file of trackedFiles) {
  if (!fs.existsSync(file)) continue;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1_000_000) continue;

  const text = fs.readFileSync(file, "utf8");
  for (const { name, pattern } of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(0, match.index);
      const line = before.split(/\r?\n/).length;
      findings.push(`${file}:${line} ${name}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Potential secrets or private paths found:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("No API keys, GitHub tokens, AWS keys, or Windows user paths found in tracked files.");
