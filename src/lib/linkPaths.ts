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

export function rehypeLinkCodePaths(repo: RepoRef | null): Plugin<[], Node> {
  return () => {
    return (tree) => {
      if (!repo) return;
      visitTextParents(tree, [], (parent, index, textNode, ancestors) => {
        if (isInsideIgnoredElement(parent) || ancestors.some(isIgnoredElement)) return;
        const replacement = linkifyText(textNode.value, repo);
        if (!replacement) return;
        parent.children.splice(index, 1, ...replacement);
      });
    };
  };
}

function linkifyText(value: string, repo: RepoRef): Array<Node> | null {
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
    try {
      nodes.push(link(path, githubFileUrl(repo, path)));
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
