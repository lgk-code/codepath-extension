#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { analyzeFeature, analyzeProject, generateSkillBlueprint } from "../src/lib/analyzer";
import { DEFAULT_SETTINGS } from "../src/lib/defaults";
import { parseGithubUrl } from "../src/lib/githubUrl";
import type { BlueprintMode, RepoRef, Settings } from "../src/types";

const server = new McpServer({
  name: "codepath-mcp",
  version: "0.1.0"
});

const githubUrlSchema = z.string().url().describe("GitHub repository or file URL, for example https://github.com/owner/repo");
const featureSchema = z.string().min(1).describe("Feature or capability to analyze, for example 插件系统, 登录流程, 缓存机制");
const modeSchema = z.enum(["human", "easyclaw-skill", "new-project"]).default("easyclaw-skill");

server.registerTool(
  "analyze_github_project",
  {
    description: "Analyze a GitHub project and return a Chinese project overview with source references.",
    inputSchema: {
      url: githubUrlSchema,
      githubToken: z.string().optional().describe("Optional GitHub token. Prefer environment variable CODEPATH_GITHUB_TOKEN.")
    }
  },
  async ({ url, githubToken }) => {
    const repo = parseRepoUrl(url);
    const result = await analyzeProject(repo, settingsFromEnv({ githubToken }));
    return textResult({
      repo,
      summary: result.summary,
      sources: result.sources
    });
  }
);

server.registerTool(
  "analyze_github_feature",
  {
    description: "Analyze one feature in a GitHub project and return implementation path, key files, and source references.",
    inputSchema: {
      url: githubUrlSchema,
      feature: featureSchema,
      githubToken: z.string().optional().describe("Optional GitHub token. Prefer environment variable CODEPATH_GITHUB_TOKEN.")
    }
  },
  async ({ url, feature, githubToken }) => {
    const repo = parseRepoUrl(url);
    const result = await analyzeFeature(repo, settingsFromEnv({ githubToken }), feature);
    return textResult({
      repo,
      feature: result.feature,
      summary: result.summary,
      sources: result.sources
    });
  }
);

server.registerTool(
  "generate_easyclaw_skill",
  {
    description: "Generate an EasyClaw-ready Skill or task handoff Markdown from a GitHub feature implementation.",
    inputSchema: {
      url: githubUrlSchema,
      feature: featureSchema,
      githubToken: z.string().optional().describe("Optional GitHub token. Prefer environment variable CODEPATH_GITHUB_TOKEN.")
    }
  },
  async ({ url, feature, githubToken }) => {
    const repo = parseRepoUrl(url);
    const result = await generateSkillBlueprint(repo, settingsFromEnv({ githubToken }), feature, "easyclaw-skill");
    return textResult({
      repo,
      feature: result.feature,
      mode: result.mode,
      summary: result.summary,
      sources: result.sources
    });
  }
);

server.registerTool(
  "generate_project_blueprint",
  {
    description: "Generate a new-project implementation blueprint inspired by one GitHub feature.",
    inputSchema: {
      url: githubUrlSchema,
      feature: featureSchema,
      mode: modeSchema.describe("Output mode. Use new-project for implementation blueprints, easyclaw-skill for EasyClaw handoff, human for readable analysis."),
      githubToken: z.string().optional().describe("Optional GitHub token. Prefer environment variable CODEPATH_GITHUB_TOKEN.")
    }
  },
  async ({ url, feature, mode, githubToken }) => {
    const repo = parseRepoUrl(url);
    const result = await generateSkillBlueprint(repo, settingsFromEnv({ githubToken }), feature, mode as BlueprintMode);
    return textResult({
      repo,
      feature: result.feature,
      mode: result.mode,
      summary: result.summary,
      sources: result.sources
    });
  }
);

function parseRepoUrl(url: string): RepoRef {
  const repo = parseGithubUrl(url);
  if (!repo || repo.pageType === "pull" || repo.pageType === "unknown") {
    throw new Error("请输入有效的 GitHub 仓库、目录或文件 URL。");
  }
  return repo;
}

function settingsFromEnv(overrides: { githubToken?: string } = {}): Settings {
  const apiKey = process.env.CODEPATH_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = process.env.CODEPATH_BASE_URL || process.env.OPENAI_BASE_URL || DEFAULT_SETTINGS.baseUrl;
  const model = process.env.CODEPATH_MODEL || process.env.OPENAI_MODEL || DEFAULT_SETTINGS.model;
  const githubToken = overrides.githubToken || process.env.CODEPATH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || DEFAULT_SETTINGS.githubToken;
  return {
    ...DEFAULT_SETTINGS,
    apiKey,
    baseUrl,
    model,
    githubToken
  };
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CodePath MCP server running on stdio");
}

main().catch((error) => {
  console.error("CodePath MCP server failed:", error);
  process.exit(1);
});
