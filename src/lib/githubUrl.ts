import type { RepoRef } from "../types";

export function parseGithubUrl(urlText: string): RepoRef | null {
  const url = new URL(urlText);
  if (url.hostname !== "github.com") return null;

  const parts = url.pathname.split("/").filter(Boolean).map(decodePathPart);
  const [owner, repo, marker] = parts;
  if (!owner || !repo) return null;

  if (marker === "blob") {
    const { branch, path } = splitBranchAndPath(parts.slice(3), "file");
    return { owner, repo, branch, path, pageType: "file" };
  }

  if (marker === "tree") {
    const { branch, path } = splitBranchAndPath(parts.slice(3), "directory");
    return { owner, repo, branch, path, pageType: "directory" };
  }

  if (marker === "pull") {
    return { owner, repo, pageType: "pull" };
  }

  if (!marker) return { owner, repo, pageType: "repo" };

  return { owner, repo, pageType: "unknown" };
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

function splitBranchAndPath(parts: string[], pageType: "file" | "directory"): { branch: string | undefined; path: string } {
  if (parts.length === 0) return { branch: undefined, path: "" };
  if (parts.length > 2 && COMMON_BRANCH_PREFIXES.has(parts[0]!.toLowerCase())) {
    return {
      branch: parts.slice(0, 2).join("/"),
      path: parts.slice(2).join("/")
    };
  }

  const pathRootIndex = parts.findIndex((part, index) => index > 0 && COMMON_PATH_ROOTS.has(part.toLowerCase()));
  if (pathRootIndex > 0) {
    return {
      branch: parts.slice(0, pathRootIndex).join("/"),
      path: parts.slice(pathRootIndex).join("/")
    };
  }

  if (pageType === "file" && parts.length > 2 && looksLikeFile(parts.at(-1) ?? "")) {
    return {
      branch: parts.slice(0, -1).join("/"),
      path: parts.at(-1) ?? ""
    };
  }

  return {
    branch: parts[0],
    path: parts.slice(1).join("/")
  };
}

function looksLikeFile(part: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(part);
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
