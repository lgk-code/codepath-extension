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
