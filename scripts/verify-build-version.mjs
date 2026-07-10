import fs from "node:fs";

const sidebar = fs.readFileSync("src/components/Sidebar.tsx", "utf8");
const content = fs.readFileSync("entrypoints/content.tsx", "utf8");
const background = fs.readFileSync("entrypoints/background.ts", "utf8");
const testCases = fs.readFileSync("docs/TEST_CASES.md", "utf8");

const uiVersion = sidebar.match(/const UI_VERSION = "([^"]+)"/)?.[1];
const contentBuild = content.match(/const CONTENT_BUILD = "([^"]+)"/)?.[1];
const backgroundBuild = background.match(/const BACKGROUND_BUILD = "([^"]+)"/)?.[1];
const documentedBuild = testCases.match(/本轮安全加固版本应显示为 `([^`]+)`/)?.[1];

if (!uiVersion || !contentBuild || !backgroundBuild || !documentedBuild) {
  console.error("Missing UI_VERSION, CONTENT_BUILD, BACKGROUND_BUILD, or documented manual-test build.");
  process.exit(1);
}

if (uiVersion !== contentBuild || uiVersion !== backgroundBuild || uiVersion !== documentedBuild) {
  console.error(
    `Build version mismatch: UI_VERSION=${uiVersion}, CONTENT_BUILD=${contentBuild}, BACKGROUND_BUILD=${backgroundBuild}, documented=${documentedBuild}`
  );
  process.exit(1);
}

console.log(`Build version verified: ${uiVersion}`);
