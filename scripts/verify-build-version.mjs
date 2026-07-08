import fs from "node:fs";

const sidebar = fs.readFileSync("src/components/Sidebar.tsx", "utf8");
const content = fs.readFileSync("entrypoints/content.tsx", "utf8");

const uiVersion = sidebar.match(/const UI_VERSION = "([^"]+)"/)?.[1];
const contentBuild = content.match(/const CONTENT_BUILD = "([^"]+)"/)?.[1];

if (!uiVersion || !contentBuild) {
  console.error("Missing UI_VERSION or CONTENT_BUILD constant.");
  process.exit(1);
}

if (uiVersion !== contentBuild) {
  console.error(`Build version mismatch: UI_VERSION=${uiVersion}, CONTENT_BUILD=${contentBuild}`);
  process.exit(1);
}

console.log(`Build version verified: ${uiVersion}`);
