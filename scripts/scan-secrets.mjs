import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";
import { scanSensitiveText } from "./secret-patterns.mjs";

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !file.startsWith(".output/") && !file.startsWith("node_modules/"));

const findings = [];
const findingKeys = new Set();
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
  let carryLineOffset = 1;
  let totalChars = 0;

  stream.on("data", (chunk) => {
    const text = carry + chunk;
    const absoluteTextStart = totalChars - carry.length;
    scanText(file, text, carryLineOffset, absoluteTextStart);
    totalChars += chunk.length;
    const nextCarryStart = Math.max(0, text.length - SCAN_CARRY_CHARS);
    carryLineOffset += countNewlines(text.slice(0, nextCarryStart));
    carry = text.slice(nextCarryStart);
  });

  await once(stream, "end");
}

function scanText(file, text, lineOffset, absoluteTextStart) {
  for (const finding of scanSensitiveText(text)) {
    const key = `${file}:${finding.name}:${absoluteTextStart + finding.index}`;
    if (findingKeys.has(key)) continue;
    findingKeys.add(key);
    const line = lineOffset + countNewlines(text.slice(0, finding.index));
    findings.push(`${file}:${line} ${finding.name}`);
  }
}

function countNewlines(text) {
  return (text.match(/\n/g) ?? []).length;
}
