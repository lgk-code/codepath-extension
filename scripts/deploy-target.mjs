import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const SAFE_TARGET_NAMES = new Set(["codepath", "chrome-mv3"]);
const DANGEROUS_PARTS = new Set(["users", "windows", "program files", "program files (x86)", "system32", "home"]);

export async function validateDeployTarget({ projectRoot, allowedRoot, targetDir, platform = process.platform, fsOps = {} }) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const ops = { lstat, realpath, ...fsOps };
  const requestedProject = pathApi.resolve(projectRoot);
  const requestedAllowed = pathApi.resolve(allowedRoot);
  const requestedTarget = pathApi.resolve(targetDir);

  if (samePath(requestedTarget, pathApi.parse(requestedTarget).root, platform)) {
    throw new Error(`Refusing to deploy to a filesystem root: ${requestedTarget}`);
  }

  const canonicalProject = await canonicalizePath(requestedProject, pathApi, ops);
  const canonicalAllowed = await canonicalizePath(requestedAllowed, pathApi, ops);
  const canonicalTarget = await canonicalizePath(requestedTarget, pathApi, ops);

  if (
    isSameOrDescendant(canonicalProject, canonicalTarget, pathApi, platform) ||
    isSameOrDescendant(canonicalTarget, canonicalProject, pathApi, platform)
  ) {
    throw new Error(`Refusing to deploy to a directory that overlaps the project directory: ${canonicalTarget}`);
  }
  if (!isStrictDescendant(canonicalAllowed, canonicalTarget, pathApi, platform)) {
    throw new Error(`Refusing to deploy outside the allowed root: ${canonicalTarget}`);
  }

  const parts = canonicalTarget
    .slice(pathApi.parse(canonicalTarget).root.length)
    .split(pathApi.sep)
    .filter(Boolean);
  if (parts.length < 2) throw new Error(`Refusing to deploy to a shallow directory: ${canonicalTarget}`);
  if (!SAFE_TARGET_NAMES.has(pathApi.basename(canonicalTarget).toLowerCase())) {
    throw new Error(`Refusing to deploy to an unexpected target name: ${canonicalTarget}`);
  }
  if (parts.some((part) => DANGEROUS_PARTS.has(part.toLowerCase()))) {
    throw new Error(`Refusing to deploy through a protected system path: ${canonicalTarget}`);
  }

  return {
    projectRoot: canonicalProject,
    allowedRoot: canonicalAllowed,
    targetDir: canonicalTarget
  };
}

async function canonicalizePath(input, pathApi, fsOps) {
  let existing = input;
  const missingParts = [];
  while (true) {
    try {
      await fsOps.lstat(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = pathApi.dirname(existing);
      if (parent === existing) throw new Error(`Unable to resolve deploy path: ${input}`);
      missingParts.unshift(pathApi.basename(existing));
      existing = parent;
    }
  }

  const canonicalExisting = await fsOps.realpath(existing);
  return pathApi.resolve(canonicalExisting, ...missingParts);
}

function isSameOrDescendant(parent, candidate, pathApi, platform) {
  return samePath(parent, candidate, platform) || isStrictDescendant(parent, candidate, pathApi, platform);
}

function isStrictDescendant(parent, candidate, pathApi, platform) {
  const relative = pathApi.relative(normalizeIdentity(parent, platform), normalizeIdentity(candidate, platform));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

function samePath(left, right, platform) {
  return normalizeIdentity(left, platform) === normalizeIdentity(right, platform);
}

function normalizeIdentity(value, platform) {
  const normalized = platform === "win32" ? path.win32.normalize(value) : path.posix.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
