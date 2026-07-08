import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !file.startsWith(".output/") && !file.startsWith("node_modules/"));

const patterns = [
  { name: "OpenAI-style API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub classic token", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/g },
  { name: "GitHub OAuth/server/user/refresh token", pattern: /\bgh[osru]_[A-Za-z0-9_]{20,}\b/g },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Windows user private path", pattern: /C:\\Users\\[A-Za-z0-9._-]+/g },
  { name: "WSL Windows user private path", pattern: /\/mnt\/c\/Users\/[A-Za-z0-9._-]+/g },
  { name: "Windows drive private path", pattern: /[A-Z]:\\(?:Users|Documents|Desktop|Downloads)\\/g }
];

const findings = [];
const SCAN_CARRY_CHARS = 512;

for (const file of trackedFiles) {
  if (!fs.existsSync(file)) continue;
  const stat = fs.statSync(file);
  if (!stat.isFile()) continue;

  await scanFile(file);
}

if (findings.length > 0) {
  console.error("Potential secrets or private paths found:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("No API keys, GitHub tokens, AWS keys, or Windows user paths found in tracked files.");

async function scanFile(file) {
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let carry = "";
  let lineOffset = 1;

  stream.on("data", (chunk) => {
    const text = carry + chunk;
    scanText(file, text, lineOffset);
    lineOffset += countNewlines(chunk);
    carry = text.slice(-SCAN_CARRY_CHARS);
  });

  await once(stream, "end");
}

function scanText(file, text, lineOffset) {
  for (const { name, pattern } of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(0, match.index);
      const line = lineOffset + countNewlines(before);
      findings.push(`${file}:${line} ${name}`);
    }
  }
}

function countNewlines(text) {
  return (text.match(/\n/g) ?? []).length;
}
