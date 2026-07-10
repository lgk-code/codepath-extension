import type { Plugin } from "unified";
import type { Node, Parent } from "unist";
import type { RepoRef } from "../types";

type TextNode = Node & {
  type: "text";
  value: string;
};

type ElementNode = Parent & {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
};

const PATH_PATTERN = /(?:^|[\s([`])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|vue|svelte|go|rs|java|kt|cs|php|rb|md|json|toml|ya?ml|txt|sh|css|scss|html))(?:[:#]L?\d+)?/g;

export function githubFileUrl(repo: RepoRef, path: string, branchOverride?: string): string {
  const branch = branchOverride || repo.branch || "main";
  const cleanPath = normalizeRepoPath(path);
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${encodeURIComponent(branch)}/${cleanPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export function immutableGithubCommit(value?: string): string | undefined {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value : undefined;
}

export function rehypeLinkCodePaths(repo: RepoRef | null, refOverride?: string, knownPaths: string[] = []): Plugin<[], Node> {
  return () => {
    return (tree) => {
      const immutableRef = immutableGithubCommit(refOverride);
      if (repo && immutableRef) {
        rewriteExplicitLinks(tree, repo, immutableRef, knownPaths);
        visitTextParents(tree, [], (parent, index, textNode, ancestors) => {
          if (isInsideIgnoredElement(parent) || ancestors.some(isIgnoredElement)) return;
          const replacement = linkifyText(textNode.value, repo, immutableRef, knownPaths);
          if (!replacement) return;
          parent.children.splice(index, 1, ...replacement);
        });
      }
      sanitizeModelLinksAndImages(tree, repo, immutableRef, knownPaths);
    };
  };
}

function sanitizeModelLinksAndImages(node: Node, repo: RepoRef | null, immutableRef: string | undefined, knownPaths: string[]) {
  if (node.type === "element") {
    const element = node as ElementNode;
    if (element.tagName === "img") {
      const alt = typeof element.properties?.alt === "string" ? element.properties.alt : "image";
      element.tagName = "span";
      element.properties = { className: ["cp-blocked-media"] };
      element.children = [text(alt)];
    } else if (element.tagName === "a") {
      const href = typeof element.properties?.href === "string" ? element.properties.href : "";
      if (!isAllowedImmutableSourceLink(href, repo, immutableRef, knownPaths)) {
        element.tagName = "span";
        element.properties = { className: ["cp-blocked-link"] };
      }
    }
  }
  if (!isParent(node)) return;
  for (const child of node.children) sanitizeModelLinksAndImages(child, repo, immutableRef, knownPaths);
}

function isAllowedImmutableSourceLink(href: string, repo: RepoRef | null, immutableRef: string | undefined, knownPaths: string[]): boolean {
  if (!href || !repo || !immutableRef) return false;
  try {
    const url = new URL(href);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      parts[0]?.toLowerCase() === repo.owner.toLowerCase() &&
      parts[1]?.toLowerCase() === repo.repo.toLowerCase() &&
      parts[2] === "blob" &&
      parts[3] === immutableRef &&
      parts.length > 4 &&
      parts.slice(4).every((part) => Boolean(part) && part !== "." && part !== "..") &&
      Boolean(knownSourcePath(parts.slice(4).join("/"), knownPaths))
    );
  } catch {
    return false;
  }
}

function rewriteExplicitLinks(node: Node, repo: RepoRef, refOverride: string | undefined, knownPaths: string[]) {
  if (node.type === "element") {
    const element = node as ElementNode;
    if (element.tagName === "a" && element.properties) {
      const path = explicitLinkPath(element, repo, knownPaths);
      if (path) {
        try {
          element.properties.href = githubFileUrl(repo, path, refOverride);
        } catch {
          // Leave malformed or unsafe links untouched.
        }
      }
    }
  }
  if (!isParent(node)) return;
  for (const child of node.children) rewriteExplicitLinks(child, repo, refOverride, knownPaths);
}

function explicitLinkPath(element: ElementNode, repo: RepoRef, knownPaths: string[]): string {
  const labelPath = textContent(element).trim();
  if (looksLikeRepoPath(labelPath)) return knownSourcePath(labelPath, knownPaths);

  const href = typeof element.properties?.href === "string" ? element.properties.href : "";
  if (!href) return "";
  const relativePath = explicitRelativePath(href);
  if (relativePath) return knownSourcePath(relativePath, knownPaths);
  try {
    const url = new URL(href);
    if (url.hostname !== "github.com") return "";
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== repo.owner || parts[1] !== repo.repo || parts[2] !== "blob") return "";
    return githubBlobPath(parts.slice(3), knownPaths);
  } catch {
    return "";
  }
}

function explicitRelativePath(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return "";
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("../")) return "";
  const path = stripLineSuffix(href.replace(/^\.\//, ""));
  return looksLikeRepoPath(path) ? path : "";
}

function githubBlobPath(parts: string[], knownPaths: string[]): string {
  return matchKnownPath(parts.slice(1), knownPaths);
}

function matchKnownPath(parts: string[], knownPaths: string[]): string {
  const normalized = knownPaths.map((path) => stripLineSuffix(path.replace(/^\.\//, ""))).filter(looksLikeRepoPath);
  const matches = normalized.filter((path) => parts.join("/").endsWith(path));
  if (matches.length !== 1) return "";
  return matches[0] ?? "";
}

function knownSourcePath(value: string, knownPaths: string[]): string {
  const candidate = stripLineSuffix(value.replace(/^\.\//, ""));
  if (!looksLikeRepoPath(candidate)) return "";
  const matches = knownPaths
    .map((path) => stripLineSuffix(path.replace(/^\.\//, "")))
    .filter((path) => path === candidate);
  return matches.length === 1 ? candidate : "";
}

function textContent(node: Node): string {
  if (node.type === "text") return (node as TextNode).value;
  if (!isParent(node)) return "";
  return node.children.map(textContent).join("");
}

function looksLikeRepoPath(value: string): boolean {
  return /^(?:\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|vue|svelte|go|rs|java|kt|cs|php|rb|md|json|toml|ya?ml|txt|sh|css|scss|html|svg)$/.test(stripLineSuffix(value));
}

function stripLineSuffix(value: string): string {
  return value.replace(/[:#]L?\d+$/, "");
}

function linkifyText(value: string, repo: RepoRef, refOverride: string, knownPaths: string[]): Array<Node> | null {
  const nodes: Array<Node> = [];
  let lastIndex = 0;
  let matched = false;

  for (const match of value.matchAll(PATH_PATTERN)) {
    const full = match[0] ?? "";
    const path = match[1];
    if (!path || match.index === undefined) continue;

    const prefixLength = full.indexOf(path);
    const pathStart = match.index + prefixLength;
    const pathEnd = pathStart + path.length;

    if (pathStart > lastIndex) {
      nodes.push(text(value.slice(lastIndex, pathStart)));
    }
    const sourcePath = knownSourcePath(path, knownPaths);
    try {
      nodes.push(sourcePath ? link(sourcePath, githubFileUrl(repo, sourcePath, refOverride)) : text(path));
    } catch {
      nodes.push(text(path));
    }
    lastIndex = pathEnd;
    matched = true;
  }

  if (!matched) return null;
  if (lastIndex < value.length) nodes.push(text(value.slice(lastIndex)));
  return nodes;
}

function visitTextParents(node: Node, ancestors: Parent[], callback: (parent: Parent, index: number, textNode: TextNode, ancestors: Parent[]) => void) {
  if (!isParent(node)) return;

  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index];
    if (!child) continue;
    if (child.type === "text") {
      callback(node, index, child as TextNode, ancestors);
      continue;
    }
    visitTextParents(child, [...ancestors, node], callback);
  }
}

function isInsideIgnoredElement(parent: Parent): boolean {
  return isIgnoredElement(parent);
}

function isIgnoredElement(parent: Parent): boolean {
  if (parent.type !== "element") return false;
  const element = parent as ElementNode;
  return ["a", "code", "pre"].includes(element.tagName);
}

function isParent(node: Node): node is Parent {
  return Array.isArray((node as Parent).children);
}

function text(value: string): TextNode {
  return { type: "text", value };
}

function normalizeRepoPath(path: string): string {
  const cleanPath = path.replace(/^\.\//, "");
  const parts = cleanPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  return cleanPath;
}

function link(label: string, href: string): ElementNode {
  return {
    type: "element",
    tagName: "a",
    properties: {
      className: ["cp-inline-path-link"],
      href,
      target: "_blank",
      rel: "noreferrer"
    },
    children: [text(label)]
  };
}
