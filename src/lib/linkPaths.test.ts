import assert from "node:assert/strict";
import { test } from "node:test";
import { githubFileUrl, rehypeLinkCodePaths } from "./linkPaths";

test("githubFileUrl uses the analyzed branch override when provided", () => {
  assert.equal(
    githubFileUrl({ owner: "acme", repo: "demo", pageType: "repo" }, "src/app.ts", "develop"),
    "https://github.com/acme/demo/blob/develop/src/app.ts"
  );
});

test("githubFileUrl rejects unsafe relative path segments", () => {
  assert.throws(
    () => githubFileUrl({ owner: "acme", repo: "demo", pageType: "repo" }, "../secret.ts"),
    /Unsafe repository path/
  );
});

test("rehypeLinkCodePaths rewrites explicit markdown links to the analyzed commit", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/acme/demo/blob/main/src/app.ts" },
        children: [{ type: "text", value: "src/app.ts" }]
      }
    ]
  };

  const plugin = rehypeLinkCodePaths({ owner: "acme", repo: "demo", pageType: "repo" }, "abcdef1234567890") as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);
  const anchor = tree.children[0];
  if (!anchor) throw new Error("Expected anchor node.");

  assert.equal(
    anchor.properties.href,
    "https://github.com/acme/demo/blob/abcdef1234567890/src/app.ts"
  );
});

test("rehypeLinkCodePaths rewrites explicit relative markdown links with non-path labels", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "./src/app.ts" },
        children: [{ type: "text", value: "入口" }]
      }
    ]
  };

  const plugin = rehypeLinkCodePaths({ owner: "acme", repo: "demo", pageType: "repo" }, "abcdef1234567890") as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(
    tree.children[0]?.properties.href,
    "https://github.com/acme/demo/blob/abcdef1234567890/src/app.ts"
  );
});

test("rehypeLinkCodePaths extracts file paths from same-repo links that use slash branch names", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/acme/demo/blob/feature/cache-fix/packages/ui/src/app.ts" },
        children: [{ type: "text", value: "入口" }]
      }
    ]
  };

  const plugin = rehypeLinkCodePaths({ owner: "acme", repo: "demo", pageType: "repo" }, "abcdef1234567890") as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(
    tree.children[0]?.properties.href,
    "https://github.com/acme/demo/blob/abcdef1234567890/packages/ui/src/app.ts"
  );
});

test("rehypeLinkCodePaths leaves ambiguous slash-branch GitHub links untouched", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/acme/demo/blob/feature/cache-fix/foo/bar.ts" },
        children: [{ type: "text", value: "入口" }]
      }
    ]
  };

  const plugin = rehypeLinkCodePaths({ owner: "acme", repo: "demo", pageType: "repo" }, "abcdef1234567890") as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(
    tree.children[0]?.properties.href,
    "https://github.com/acme/demo/blob/feature/cache-fix/foo/bar.ts"
  );
});

test("rehypeLinkCodePaths uses known source paths to disambiguate slash-branch GitHub links", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/acme/demo/blob/feature/cache-fix/foo/bar.ts" },
        children: [{ type: "text", value: "入口" }]
      }
    ]
  };

  const plugin = rehypeLinkCodePaths({ owner: "acme", repo: "demo", pageType: "repo" }, "abcdef1234567890", ["foo/bar.ts"]) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(
    tree.children[0]?.properties.href,
    "https://github.com/acme/demo/blob/abcdef1234567890/foo/bar.ts"
  );
});

test("rehypeLinkCodePaths leaves slash-branch GitHub links untouched when known source suffixes are ambiguous", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/acme/demo/blob/feature/cache-fix/foo/bar.ts" },
        children: [{ type: "text", value: "入口" }]
      }
    ]
  };

  const plugin = rehypeLinkCodePaths(
    { owner: "acme", repo: "demo", pageType: "repo" },
    "abcdef1234567890",
    ["foo/bar.ts", "cache-fix/foo/bar.ts"]
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(
    tree.children[0]?.properties.href,
    "https://github.com/acme/demo/blob/feature/cache-fix/foo/bar.ts"
  );
});
