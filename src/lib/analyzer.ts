import type { FileExplanation, FeaturePath, ProjectOverview, RepoRef, Settings, SourceRef, TreeFile } from "../types";
import { GithubClient } from "./githubClient";
import { ZipGithubClient } from "./zipGithubClient";
import { chat } from "./aiClient";
import { classifyPath, isLikelyImportant, isUsefulPath } from "./fileRules";
import { expandFeatureKeywords } from "./featureKeywords";
import { extractImports } from "./imports";

type FileSnippet = {
  path: string;
  content: string;
  imports?: string[];
};

type SourceClient = {
  getRepo(owner: string, repo: string): Promise<{ default_branch: string }>;
  getTree(owner: string, repo: string, branch: string): Promise<TreeFile[]>;
  getFile(owner: string, repo: string, path: string, ref: string): Promise<string>;
};

export async function analyzeProject(repo: RepoRef, settings: Settings): Promise<ProjectOverview> {
  const gh = await createSourceClient(repo, settings);
  const { branch, files } = await loadTree(gh, repo);
  const usefulFiles = files.filter((file) => file.type === "blob" && isUsefulPath(file.path));
  const selected = pickImportantFiles(usefulFiles);
  const snippets = await loadSnippets(gh, repo, branch, selected, 14000);

  const treeSummary = summarizeTree(usefulFiles);
  const content = await chat(settings, [
    systemPrompt(),
    {
      role: "user",
      content: `请分析这个 GitHub 项目，输出大白话项目导读、技术栈、目录说明、入口文件判断、推荐阅读路线。不要编造不存在的文件；关键结论要引用文件路径。\n\n仓库：${repo.owner}/${repo.repo}\n分支：${branch}\n\n文件树摘要：\n${treeSummary}\n\n关键文件内容：\n${formatSnippets(snippets)}`
    }
  ]);

  return { summary: content, sources: snippets.map((item) => ({ path: item.path })) };
}

export async function analyzeFeature(repo: RepoRef, settings: Settings, feature: string): Promise<FeaturePath> {
  const gh = await createSourceClient(repo, settings);
  const { branch, files } = await loadTree(gh, repo);
  const usefulFiles = files.filter((file) => file.type === "blob" && isUsefulPath(file.path));
  const keywords = expandFeatureKeywords(feature);
  const candidates = scoreFeatureFiles(usefulFiles, keywords).slice(0, 14);
  const snippets = await loadSnippets(gh, repo, branch, candidates, 22000);
  const withImports = snippets.map((snippet) => ({ ...snippet, imports: extractImports(snippet.content) }));

  const content = await chat(settings, [
    systemPrompt(),
    {
      role: "user",
      content: `用户想在不部署、不运行项目的情况下理解某个功能。请基于候选源码分析"${feature}"的实现思路，输出：1. 功能大概怎么实现；2. 详细实现路径/步骤；3. 每一步对应文件；4. 二次开发要改哪些地方；5. 哪些结论只是推测。不要编造不存在的文件。\n\n仓库：${repo.owner}/${repo.repo}\n分支：${branch}\n关键词：${keywords.join(", ")}\n\n候选文件：\n${withImports.map((item) => `- ${item.path} (${classifyPath(item.path)}) imports: ${(item.imports ?? []).join(", ") || "无"}`).join("\n")}\n\n源码片段：\n${formatSnippets(withImports)}`
    }
  ]);

  return {
    feature,
    summary: content,
    sources: withImports.map((item) => ({ path: item.path, reason: "功能候选文件" }))
  };
}

export async function explainFile(repo: RepoRef, settings: Settings): Promise<FileExplanation> {
  if (!repo.path) throw new Error("当前页面不是 GitHub 文件页。");
  const gh = await createSourceClient(repo, settings);
  const { branch } = await loadTree(gh, repo);
  const content = await gh.getFile(repo.owner, repo.repo, repo.path, repo.branch || branch);
  const imports = extractImports(content);

  const summary = await chat(settings, [
    systemPrompt(),
    {
      role: "user",
      content: `请解释当前文件，用户是学习者/二次开发者。输出：这个文件负责什么、主要结构、它可能属于哪个功能、依赖关系、阅读建议和修改风险。不要编造不存在的代码。\n\n仓库：${repo.owner}/${repo.repo}\n文件：${repo.path}\nimports：${imports.join(", ") || "无"}\n\n源码：\n${truncate(content, 18000)}`
    }
  ]);

  return { path: repo.path, summary, sources: [{ path: repo.path }] };
}

export async function answerQuestion(repo: RepoRef, settings: Settings, question: string, context?: string): Promise<ProjectOverview> {
  const gh = await createSourceClient(repo, settings);
  const { branch, files } = await loadTree(gh, repo);
  const usefulFiles = files.filter((file) => file.type === "blob" && isUsefulPath(file.path));
  const keywords = question
    .toLowerCase()
    .split(/[\s,，/._-]+/)
    .filter((item) => item.length >= 2)
    .slice(0, 12);
  const candidates = scoreFeatureFiles(usefulFiles, keywords).slice(0, 12);
  const selected = candidates.length > 0 ? candidates : pickImportantFiles(usefulFiles).slice(0, 12);
  const snippets = await loadSnippets(gh, repo, branch, selected, 20000);

  const content = await chat(settings, [
    systemPrompt(),
    {
      role: "user",
      content: `用户正在基于 CodePath 的项目导读继续追问。请只根据已有上下文和源码片段回答，不要编造不存在的文件。回答要直接、具体，尽量给出文件路径和阅读/修改步骤。\n\n仓库：${repo.owner}/${repo.repo}\n分支：${branch}\n\n上一轮上下文：\n${context ? truncate(context, 9000) : "无"}\n\n用户问题：\n${question}\n\n相关源码片段：\n${formatSnippets(snippets)}`
    }
  ]);

  return { summary: content, sources: snippets.map((item) => ({ path: item.path })) };
}

async function createSourceClient(repo: RepoRef, settings: Settings): Promise<SourceClient> {
  const apiClient = new GithubClient(settings);
  try {
    await apiClient.getRepo(repo.owner, repo.repo);
    return apiClient;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("403") && !message.toLowerCase().includes("rate limit")) throw error;
    const zipClient = new ZipGithubClient(repo.owner, repo.repo, repo.branch);
    return {
      getRepo: () => zipClient.getRepo(),
      getTree: () => zipClient.getTree(),
      getFile: (_owner, _repo, path) => zipClient.getFile(path)
    };
  }
}

async function loadTree(gh: SourceClient, repo: RepoRef): Promise<{ branch: string; files: TreeFile[] }> {
  const info = await gh.getRepo(repo.owner, repo.repo);
  const branch = repo.branch || info.default_branch;
  const files = await gh.getTree(repo.owner, repo.repo, branch);
  return { branch, files };
}

function pickImportantFiles(files: TreeFile[]): TreeFile[] {
  const important = files.filter((file) => isLikelyImportant(file.path));
  const topLevel = files.filter((file) => !file.path.includes("/") && isUsefulPath(file.path));
  return uniqueByPath([...important, ...topLevel]).slice(0, 28);
}

function scoreFeatureFiles(files: TreeFile[], keywords: string[]): TreeFile[] {
  const scored = files
    .map((file) => {
      const lower = file.path.toLowerCase();
      let score = 0;
      for (const keyword of keywords) {
        if (lower.includes(keyword)) score += 8;
      }
      if (lower.includes("/pages/") || lower.includes("/views/")) score += 2;
      if (lower.includes("/api/") || lower.includes("/services/") || lower.includes("/store/")) score += 2;
      if (lower.includes("test") || lower.includes("spec")) score += 1;
      return { file, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return scored.map((item) => item.file);
}

async function loadSnippets(gh: SourceClient, repo: RepoRef, branch: string, files: TreeFile[], budget: number): Promise<FileSnippet[]> {
  const snippets: FileSnippet[] = [];
  let used = 0;
  for (const file of files) {
    if (used >= budget) break;
    if ((file.size ?? 0) > 180_000) continue;
    try {
      const content = await gh.getFile(repo.owner, repo.repo, file.path, branch);
      const remaining = budget - used;
      const clipped = truncate(content, Math.min(6000, remaining));
      used += clipped.length;
      snippets.push({ path: file.path, content: clipped });
    } catch {
      // Skip files GitHub refuses or cannot decode; the rest of the context is still useful.
    }
  }
  return snippets;
}

function summarizeTree(files: TreeFile[]): string {
  const dirs = new Map<string, number>();
  for (const file of files) {
    const first = file.path.split("/")[0] ?? file.path;
    dirs.set(first, (dirs.get(first) ?? 0) + 1);
  }
  const dirText = [...dirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([dir, count]) => `- ${dir}: ${count} 个文件`)
    .join("\n");
  const sampleFiles = files
    .slice(0, 120)
    .map((file) => `- ${file.path}`)
    .join("\n");
  return `主要目录：\n${dirText}\n\n部分文件：\n${sampleFiles}`;
}

function formatSnippets(snippets: FileSnippet[]): string {
  return snippets
    .map((item) => `\n--- ${item.path} ---\n${item.content}`)
    .join("\n");
}

function systemPrompt() {
  return {
    role: "system" as const,
    content:
      "你是 CodePath，一个 GitHub 源码导读助手。用户不想部署或运行项目，只想通过源码理解项目思路、功能路径和二次开发路线。回答要用中文大白话，先给结论，再给文件路径。只根据提供的源码和文件树判断；没有依据就明确说是推测。"
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n... 内容过长，已截断 ...`;
}

function uniqueByPath(files: TreeFile[]): TreeFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}
