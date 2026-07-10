import type { RepoRef } from "../types";

const MAX_GITHUB_PATH_CHARACTERS = 8_192;
const MAX_GITHUB_PATH_SEGMENTS = 128;

export function parseGithubUrl(urlText: string): RepoRef | null {
  const url = new URL(urlText);
  if (url.hostname !== "github.com") return null;
  if (url.pathname.length > MAX_GITHUB_PATH_CHARACTERS) return null;

  const rawParts = url.pathname.split("/").filter(Boolean);
  if (rawParts.length > MAX_GITHUB_PATH_SEGMENTS) return null;

  const parts: string[] = [];
  for (const rawPart of rawParts) {
    const part = decodePathPart(rawPart);
    if (part === "." || part === ".." || part.includes("/") || part.includes("\\")) return null;
    parts.push(part);
  }
  const [owner, repo, marker] = parts;
  if (!owner || !repo || !isValidGithubRepositoryIdentity(owner, repo)) return null;

  if (marker === "blob") {
    const selection = splitBranchAndPath(parts.slice(3), "file");
    return { owner, repo, branch: selection.branch, path: selection.path, pageType: "file", ...candidateProperty(selection.refCandidates) };
  }

  if (marker === "tree") {
    const selection = splitBranchAndPath(parts.slice(3), "directory");
    return { owner, repo, branch: selection.branch, path: selection.path, pageType: "directory", ...candidateProperty(selection.refCandidates) };
  }

  if (marker === "pull") {
    return { owner, repo, pageType: "pull" };
  }

  if (!marker) return { owner, repo, pageType: "repo" };

  return { owner, repo, pageType: "unknown" };
}

export function isValidGithubRepositoryIdentity(owner: string, repo: string): boolean {
  return isValidGithubOwner(owner) && isValidGithubRepo(repo);
}

function isValidGithubOwner(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
}

function isValidGithubRepo(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9._-]{1,100}$/.test(value);
}

const COMMON_PATH_ROOTS = new Set([
  ".github",
  "app",
  "apps",
  "bin",
  "cmd",
  "config",
  "docs",
  "entrypoints",
  "example",
  "examples",
  "lib",
  "packages",
  "public",
  "scripts",
  "src",
  "test",
  "tests"
]);

const COMMON_BRANCH_PREFIXES = new Set(["bugfix", "build", "chore", "ci", "docs", "feat", "feature", "fix", "hotfix", "refactor", "release", "test"]);

function splitBranchAndPath(
  parts: string[],
  pageType: "file" | "directory"
): { branch: string | undefined; path: string; refCandidates?: Array<{ refName: string; path: string }> } {
  if (parts.length === 0) return { branch: undefined, path: "" };
  if (parts.length > 1 && (looksLikeCommitRef(parts[0]!) || looksLikeReleaseTag(parts[0]!))) {
    return {
      branch: parts[0],
      path: parts.slice(1).join("/"),
      ...candidateProperty(possibleRefCandidates(parts, pageType))
    };
  }
  if (parts.length > 2 && COMMON_BRANCH_PREFIXES.has(parts[0]!.toLowerCase())) {
    return {
      branch: parts.slice(0, 2).join("/"),
      path: parts.slice(2).join("/"),
      refCandidates: possibleRefCandidates(parts, pageType)
    };
  }

  const pathRootIndex = parts.findIndex((part, index) => index > 0 && COMMON_PATH_ROOTS.has(part.toLowerCase()));
  if (pathRootIndex > 0) {
    return {
      branch: parts.slice(0, pathRootIndex).join("/"),
      path: parts.slice(pathRootIndex).join("/"),
      refCandidates: possibleRefCandidates(parts, pageType)
    };
  }

  if (pageType === "file" && parts.length > 2 && looksLikeFile(parts.at(-1) ?? "")) {
    return {
      branch: parts.slice(0, -1).join("/"),
      path: parts.at(-1) ?? "",
      refCandidates: possibleRefCandidates(parts, pageType)
    };
  }

  return {
    branch: parts[0],
    path: parts.slice(1).join("/"),
    refCandidates: possibleRefCandidates(parts, pageType)
  };
}

function possibleRefCandidates(parts: string[], pageType: "file" | "directory"): Array<{ refName: string; path: string }> | undefined {
  const finalSplit = pageType === "file" ? parts.length - 1 : parts.length;
  if (finalSplit < 2) return undefined;
  return Array.from({ length: finalSplit }, (_item, index) => {
    const split = index + 1;
    return {
      refName: parts.slice(0, split).join("/"),
      path: parts.slice(split).join("/")
    };
  });
}

function candidateProperty(refCandidates: Array<{ refName: string; path: string }> | undefined) {
  return refCandidates ? { refCandidates } : {};
}

function looksLikeFile(part: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(part);
}

function looksLikeCommitRef(part: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(part);
}

function looksLikeReleaseTag(part: string): boolean {
  return /^v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9._-]+)?$/i.test(part);
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
