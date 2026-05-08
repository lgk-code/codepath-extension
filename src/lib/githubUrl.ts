import type { RepoRef } from "../types";

export function parseGithubUrl(urlText: string): RepoRef | null {
  const url = new URL(urlText);
  if (url.hostname !== "github.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo, marker] = parts;
  if (!owner || !repo) return null;

  if (marker === "blob") {
    const branch = parts[3];
    const path = parts.slice(4).join("/");
    return { owner, repo, branch, path, pageType: "file" };
  }

  if (marker === "tree") {
    const branch = parts[3];
    const path = parts.slice(4).join("/");
    return { owner, repo, branch, path, pageType: "directory" };
  }

  if (marker === "pull") {
    return { owner, repo, pageType: "pull" };
  }

  if (!marker) return { owner, repo, pageType: "repo" };

  return { owner, repo, pageType: "unknown" };
}
