import fs from "node:fs";

const expectedTools = [
  "analyze_github_project",
  "analyze_github_feature",
  "generate_openclaw_skill",
  "generate_project_blueprint"
];

const text = fs.readFileSync("scripts/codepath-mcp.ts", "utf8");
const tools = [...text.matchAll(/server\.registerTool\(\s*\n\s*"([^"]+)"/g)].map((match) => match[1]);

const missing = expectedTools.filter((tool) => !tools.includes(tool));
const extra = tools.filter((tool) => !expectedTools.includes(tool));
const unsafeTokenParameter = text
  .split("server.registerTool")
  .slice(1)
  .some((block) => block.slice(0, block.indexOf("async")).includes("githubToken"));

console.log(`Detected MCP tools:\n${tools.map((tool) => `- ${tool}`).join("\n")}`);

if (tools.length !== expectedTools.length || missing.length > 0 || extra.length > 0) {
  if (missing.length > 0) console.error(`Missing tools: ${missing.join(", ")}`);
  if (extra.length > 0) console.error(`Unexpected tools: ${extra.join(", ")}`);
  process.exit(1);
}

if (unsafeTokenParameter) {
  console.error("MCP tools must not expose githubToken as an input parameter; use CODEPATH_GITHUB_TOKEN instead.");
  process.exit(1);
}
