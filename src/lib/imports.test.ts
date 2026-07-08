import assert from "node:assert/strict";
import { test } from "node:test";
import { extractImports } from "./imports";

test("extractImports includes dynamic imports and ignores comments", () => {
  const imports = extractImports(`
    import React from "react";
    const lazy = import("./lazy");
    // import ignored from "./commented";
    /* const fake = require("./block-commented"); */
    const runtime = require("./runtime");
  `);

  assert.deepEqual(imports, ["react", "./lazy", "./runtime"]);
});
