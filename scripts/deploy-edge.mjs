import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DEV_RELOAD_MARKER_PATH, createDevReloadMarker, extractBuildId } from "./dev-reload-marker.mjs";

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, ".output", "chrome-mv3");
const defaultTargetDir =
  process.platform === "win32"
    ? "D:\\edge下载\\CodePath"
    : "/mnt/d/edge下载/CodePath";
const targetDir = process.env.CODEPATH_EDGE_EXTENSION_DIR || defaultTargetDir;
const resolvedTargetDir = path.resolve(targetDir);
const allowedRoot = path.resolve(process.env.CODEPATH_EDGE_EXTENSION_ROOT || path.dirname(defaultTargetDir));

if (!isSafeExtensionDir(resolvedTargetDir)) {
  throw new Error(`Refusing to deploy to unsafe extension directory: ${resolvedTargetDir}`);
}

await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);

if (!existsSync(outputDir)) {
  throw new Error(`Build output not found: ${outputDir}`);
}

const contentSource = await readFile(path.join(projectRoot, "entrypoints", "content.tsx"), "utf8");
const buildId = extractBuildId(contentSource);
const marker = createDevReloadMarker(buildId);

await mkdir(resolvedTargetDir, { recursive: true });
await rm(resolvedTargetDir, { recursive: true, force: true });
await mkdir(resolvedTargetDir, { recursive: true });
await cp(outputDir, resolvedTargetDir, { recursive: true });
await writeFile(path.join(resolvedTargetDir, DEV_RELOAD_MARKER_PATH), `${JSON.stringify(marker, null, 2)}\n`, "utf8");

console.log(`CodePath Edge build deployed to ${resolvedTargetDir}`);
console.log(`Dev reload marker written for ${buildId}.`);
console.log("Next: wait for CodePath to self-reload, then refresh the GitHub page if the tab was not refreshed automatically.");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(`${command} ${args.join(" ")}`, { stdio: "inherit", shell: true })
        : spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function isSafeExtensionDir(dir) {
  const parsed = path.parse(dir);
  if (parsed.root === dir) return false;

  const normalized = path.normalize(dir);
  const normalizedProjectRoot = path.normalize(projectRoot);
  if (normalized === normalizedProjectRoot || normalized.startsWith(`${normalizedProjectRoot}${path.sep}`)) return false;
  const normalizedAllowedRoot = path.normalize(allowedRoot);
  if (normalized !== normalizedAllowedRoot && !normalized.startsWith(`${normalizedAllowedRoot}${path.sep}`)) return false;

  const parts = normalized
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  if (parts.length < 2) return false;

  const basename = path.basename(normalized).toLowerCase();
  if (!["codepath", "chrome-mv3"].includes(basename)) return false;

  const dangerous = new Set(["users", "windows", "program files", "program files (x86)", "system32", "home"]);
  return !parts.some((part) => dangerous.has(part.toLowerCase()));
}
