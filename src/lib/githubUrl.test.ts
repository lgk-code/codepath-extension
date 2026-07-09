import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGithubUrl } from "./githubUrl";

test("parseGithubUrl handles common slash branch file URLs", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/demo/blob/feature/sidebar/src/app.ts"), {
    owner: "acme",
    repo: "demo",
    branch: "feature/sidebar",
    path: "src/app.ts",
    pageType: "file"
  });
});

test("parseGithubUrl keeps common directory roots out of slash branch names", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/demo/blob/feature/sidebar/examples/demo.ts"), {
    owner: "acme",
    repo: "demo",
    branch: "feature/sidebar",
    path: "examples/demo.ts",
    pageType: "file"
  });
});

test("parseGithubUrl decodes file path segments", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/demo/blob/main/docs/hello%20world.md"), {
    owner: "acme",
    repo: "demo",
    branch: "main",
    path: "docs/hello world.md",
    pageType: "file"
  });
});

test("parseGithubUrl keeps commit permalink refs separate from file paths", () => {
  const commit = "1234567890abcdef1234567890abcdef12345678";
  assert.deepEqual(parseGithubUrl(`https://github.com/acme/demo/blob/${commit}/foo/bar.ts`), {
    owner: "acme",
    repo: "demo",
    branch: commit,
    path: "foo/bar.ts",
    pageType: "file"
  });
});

test("parseGithubUrl keeps tag refs separate from unknown directory paths", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/demo/blob/v1.0.0/foo/bar.ts"), {
    owner: "acme",
    repo: "demo",
    branch: "v1.0.0",
    path: "foo/bar.ts",
    pageType: "file"
  });
});
