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

  const plugin = rehypeLinkCodePaths(
    { owner: "acme", repo: "demo", pageType: "repo" },
    "abcdef1234567890abcdef1234567890abcdef12",
    ["src/app.ts"]
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);
  const anchor = tree.children[0];
  if (!anchor) throw new Error("Expected anchor node.");

  assert.equal(
    anchor.properties.href,
    "https://github.com/acme/demo/blob/abcdef1234567890abcdef1234567890abcdef12/src/app.ts"
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

  const plugin = rehypeLinkCodePaths(
    { owner: "acme", repo: "demo", pageType: "repo" },
    "abcdef1234567890abcdef1234567890abcdef12",
    ["src/app.ts"]
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(
    tree.children[0]?.properties.href,
    "https://github.com/acme/demo/blob/abcdef1234567890abcdef1234567890abcdef12/src/app.ts"
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

  const plugin = rehypeLinkCodePaths(
    { owner: "acme", repo: "demo", pageType: "repo" },
    "abcdef1234567890abcdef1234567890abcdef12",
    ["packages/ui/src/app.ts"]
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(
    tree.children[0]?.properties.href,
    "https://github.com/acme/demo/blob/abcdef1234567890abcdef1234567890abcdef12/packages/ui/src/app.ts"
  );
});

test("rehypeLinkCodePaths makes ambiguous slash-branch GitHub links inert", () => {
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

  const plugin = rehypeLinkCodePaths({ owner: "acme", repo: "demo", pageType: "repo" }, "abcdef1234567890abcdef1234567890abcdef12") as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(tree.children[0]?.tagName, "span");
  assert.equal(tree.children[0]?.properties.href, undefined);
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

  const plugin = rehypeLinkCodePaths({ owner: "acme", repo: "demo", pageType: "repo" }, "abcdef1234567890abcdef1234567890abcdef12", ["foo/bar.ts"]) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(
    tree.children[0]?.properties.href,
    "https://github.com/acme/demo/blob/abcdef1234567890abcdef1234567890abcdef12/foo/bar.ts"
  );
});

test("rehypeLinkCodePaths makes ambiguous known source suffix links inert", () => {
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
    "abcdef1234567890abcdef1234567890abcdef12",
    ["foo/bar.ts", "cache-fix/foo/bar.ts"]
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;
  transformer(tree);

  assert.equal(tree.children[0]?.tagName, "span");
  assert.equal(tree.children[0]?.properties.href, undefined);
});

test("rehypeLinkCodePaths renders external model links as inert text", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://tracker.example/collect" },
        children: [{ type: "text", value: "external" }]
      }
    ]
  };
  const plugin = rehypeLinkCodePaths(
    { owner: "acme", repo: "demo", pageType: "repo" },
    "abcdef1234567890abcdef1234567890abcdef12"
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;

  transformer(tree);

  assert.equal(tree.children[0]?.tagName, "span");
  assert.equal("href" in (tree.children[0]?.properties ?? {}), false);
});

test("rehypeLinkCodePaths removes model-provided image sources", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "img",
        properties: { src: "https://tracker.example/pixel.png", alt: "diagram" },
        children: []
      }
    ]
  };
  const plugin = rehypeLinkCodePaths(
    { owner: "acme", repo: "demo", pageType: "repo" },
    "abcdef1234567890abcdef1234567890abcdef12"
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;

  transformer(tree);

  assert.equal(tree.children[0]?.tagName, "span");
  assert.equal("src" in (tree.children[0]?.properties ?? {}), false);
});

test("rehypeLinkCodePaths does not create source links without an immutable commit", () => {
  const tree = {
    type: "root",
    children: [{ type: "text", value: "Read src/app.ts next." }]
  };
  const plugin = rehypeLinkCodePaths({ owner: "acme", repo: "demo", pageType: "repo" }) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;

  transformer(tree);

  assert.equal(tree.children.every((node) => node.type === "text"), true);
});

test("rehypeLinkCodePaths linkifies only paths present in analyzed sources", () => {
  const tree = {
    type: "root",
    children: [{ type: "text", value: "Read src/app.ts, not src/not-real.ts." }]
  };
  const plugin = rehypeLinkCodePaths(
    { owner: "acme", repo: "demo", pageType: "repo" },
    "abcdef1234567890abcdef1234567890abcdef12",
    ["src/app.ts"]
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;

  transformer(tree);

  const nodes = tree.children as Array<{ type: string; tagName?: string; properties?: Record<string, string> }>;
  const anchors = nodes.filter((node) => node.type === "element" && node.tagName === "a");
  assert.equal(anchors.length, 1);
  assert.match(anchors[0]?.properties?.href ?? "", /\/src\/app\.ts$/);
  assert.equal(JSON.stringify(tree).includes("src/not-real.ts"), true);
});

test("rehypeLinkCodePaths makes same-commit links inert when the path was not analyzed", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/acme/demo/blob/abcdef1234567890abcdef1234567890abcdef12/src/not-real.ts" },
        children: [{ type: "text", value: "src/not-real.ts" }]
      }
    ]
  };
  const plugin = rehypeLinkCodePaths(
    { owner: "acme", repo: "demo", pageType: "repo" },
    "abcdef1234567890abcdef1234567890abcdef12",
    ["src/app.ts"]
  ) as unknown as () => unknown;
  const transformer = plugin() as (tree: unknown) => void;

  transformer(tree);

  assert.equal(tree.children[0]?.tagName, "span");
});
