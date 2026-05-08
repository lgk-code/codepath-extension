import type { FileExplanation, FeaturePath, ProjectOverview, RepoRef, Settings, TreeFile } from "../types";
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

type ProjectKind = "python-ml" | "frontend" | "node-backend" | "python-app" | "generic";

type ProjectProfile = {
  kind: ProjectKind;
  label: string;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

export async function analyzeProject(repo: RepoRef, settings: Settings): Promise<ProjectOverview> {
  const gh = await createSourceClient(repo, settings);
  const { branch, files } = await loadTree(gh, repo);
  const usefulFiles = files.filter((file) => file.type === "blob" && isUsefulPath(file.path));
  const profile = detectProjectProfile(usefulFiles);
  const selected = pickImportantFiles(usefulFiles, profile);
  const snippets = await loadSnippets(gh, repo, branch, selected, profile.kind === "python-ml" ? 22000 : 16000);

  const treeSummary = summarizeTree(usefulFiles);
  const content = await chat(settings, [
    systemPrompt(profile),
    {
      role: "user",
      content: `${projectPrompt(profile)}

Repository: ${repo.owner}/${repo.repo}
Branch: ${branch}

Detected project type:
- ${profile.label}
- Confidence: ${profile.confidence}
- Reasons: ${profile.reasons.join("; ") || "No strong signal"}

Repository tree summary:
${treeSummary}

Key file contents:
${formatSnippets(snippets)}`
    }
  ]);

  return { summary: content, sources: snippets.map((item) => ({ path: item.path })) };
}

export async function analyzeFeature(repo: RepoRef, settings: Settings, feature: string): Promise<FeaturePath> {
  const gh = await createSourceClient(repo, settings);
  const { branch, files } = await loadTree(gh, repo);
  const usefulFiles = files.filter((file) => file.type === "blob" && isUsefulPath(file.path));
  const profile = detectProjectProfile(usefulFiles);
  const keywords = expandFeatureKeywords(feature);
  const candidates = scoreFeatureFiles(usefulFiles, keywords, profile).slice(0, 16);
  const snippets = await loadSnippets(gh, repo, branch, candidates, 24000);
  const withImports = snippets.map((snippet) => ({ ...snippet, imports: extractImports(snippet.content) }));

  const content = await chat(settings, [
    systemPrompt(profile),
    {
      role: "user",
      content: `The user wants to understand one feature without cloning, deploying, or running the project.

Feature: ${feature}
Repository: ${repo.owner}/${repo.repo}
Branch: ${branch}
Detected project type: ${profile.label}
Expanded keywords: ${keywords.join(", ")}

Please output:
1. What this feature probably does.
2. The detailed implementation path, step by step.
3. The file responsible for each step.
4. What to modify for secondary development.
5. What is confirmed by source code and what is only a cautious inference.

Candidate files:
${withImports.map((item) => `- ${item.path} (${classifyPath(item.path)}) imports: ${(item.imports ?? []).join(", ") || "none"}`).join("\n")}

Source snippets:
${formatSnippets(withImports)}`
    }
  ]);

  return {
    feature,
    summary: content,
    sources: withImports.map((item) => ({ path: item.path, reason: "feature candidate" }))
  };
}

export async function explainFile(repo: RepoRef, settings: Settings): Promise<FileExplanation> {
  if (!repo.path) throw new Error("The current page is not a GitHub file page.");
  const gh = await createSourceClient(repo, settings);
  const { branch, files } = await loadTree(gh, repo);
  const usefulFiles = files.filter((file) => file.type === "blob" && isUsefulPath(file.path));
  const profile = detectProjectProfile(usefulFiles);
  const content = await gh.getFile(repo.owner, repo.repo, repo.path, repo.branch || branch);
  const imports = extractImports(content);

  const summary = await chat(settings, [
    systemPrompt(profile),
    {
      role: "user",
      content: `Explain the current file for a learner or secondary developer.

Repository: ${repo.owner}/${repo.repo}
Detected project type: ${profile.label}
File: ${repo.path}
Imports: ${imports.join(", ") || "none"}

Please explain:
1. What this file is responsible for.
2. Its main classes/functions/components.
3. Where it sits in the project.
4. What it depends on.
5. What to be careful about before editing it.

Source:
${truncate(content, 18000)}`
    }
  ]);

  return { path: repo.path, summary, sources: [{ path: repo.path }] };
}

export async function answerQuestion(repo: RepoRef, settings: Settings, question: string, context?: string): Promise<ProjectOverview> {
  const gh = await createSourceClient(repo, settings);
  const { branch, files } = await loadTree(gh, repo);
  const usefulFiles = files.filter((file) => file.type === "blob" && isUsefulPath(file.path));
  const profile = detectProjectProfile(usefulFiles);
  const keywords = question
    .toLowerCase()
    .split(/[\s,，/._-]+/)
    .filter((item) => item.length >= 2)
    .slice(0, 14);
  const candidates = scoreFeatureFiles(usefulFiles, keywords, profile).slice(0, 14);
  const selected = candidates.length > 0 ? candidates : pickImportantFiles(usefulFiles, profile).slice(0, 14);
  const snippets = await loadSnippets(gh, repo, branch, selected, 22000);

  const content = await chat(settings, [
    systemPrompt(profile),
    {
      role: "user",
      content: `The user is asking a follow-up question based on CodePath's repository guide. Answer only from the previous context and the source snippets. Do not invent files.

Repository: ${repo.owner}/${repo.repo}
Branch: ${branch}
Detected project type: ${profile.label}

Previous context:
${context ? truncate(context, 9000) : "None"}

User question:
${question}

Relevant source snippets:
${formatSnippets(snippets)}`
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

function detectProjectProfile(files: TreeFile[]): ProjectProfile {
  const paths = files.map((file) => file.path.toLowerCase());
  const has = (pattern: string | RegExp) =>
    typeof pattern === "string" ? paths.some((path) => path === pattern || path.includes(pattern)) : paths.some((path) => pattern.test(path));

  const reasons: string[] = [];

  const pythonFiles = paths.filter((path) => path.endsWith(".py")).length;
  const mlSignals = [
    "requirements.txt",
    "environment.yml",
    "pyproject.toml",
    "training/",
    "train.py",
    "trainer",
    "models/",
    "model/",
    "datasets/",
    "dataloader",
    "eval/",
    "inference",
    "checkpoint",
    "torch",
    "pytorch"
  ];
  const mlScore = mlSignals.reduce((score, signal) => score + (has(signal) ? 1 : 0), 0);
  if (pythonFiles > 0) reasons.push(`${pythonFiles} Python source files`);
  if (mlScore >= 3) reasons.push(`ML/research structure signals: ${mlScore}`);
  if (pythonFiles >= 8 && mlScore >= 3) {
    return { kind: "python-ml", label: "Python ML / research codebase", confidence: mlScore >= 6 ? "high" : "medium", reasons };
  }

  if (has("package.json") && (has("src/") || has("app/") || has("pages/") || has("vite.config") || has("next.config"))) {
    return {
      kind: "frontend",
      label: "Frontend JavaScript/TypeScript project",
      confidence: "medium",
      reasons: ["package.json plus frontend source/config files"]
    };
  }

  if (has("package.json") && (has("server") || has("express") || has("fastify") || has("nestjs"))) {
    return {
      kind: "node-backend",
      label: "Node.js backend project",
      confidence: "medium",
      reasons: ["package.json plus backend naming signals"]
    };
  }

  if (pythonFiles > 0) {
    return {
      kind: "python-app",
      label: "Python project",
      confidence: "low",
      reasons
    };
  }

  return {
    kind: "generic",
    label: "Generic source repository",
    confidence: "low",
    reasons: ["No strong framework or project-type signal"]
  };
}

function pickImportantFiles(files: TreeFile[], profile: ProjectProfile): TreeFile[] {
  const topLevel = files.filter((file) => !file.path.includes("/") && isUsefulPath(file.path));
  const generallyImportant = files.filter((file) => isLikelyImportant(file.path));
  const profileImportant = files.filter((file) => profilePathScore(file.path, profile) > 0).sort((a, b) => profilePathScore(b.path, profile) - profilePathScore(a.path, profile));
  return uniqueByPath([...profileImportant, ...generallyImportant, ...topLevel]).slice(0, 34);
}

function profilePathScore(path: string, profile: ProjectProfile): number {
  const p = path.toLowerCase();
  let score = 0;
  if (p.endsWith("readme.md")) score += 20;

  if (profile.kind === "python-ml") {
    if (/requirements\.txt|environment\.ya?ml|pyproject\.toml/.test(p)) score += 12;
    if (/(^|\/)(train|training|trainer|launch|main|infer|inference|eval|evaluate|demo)[\w.-]*\.py$/.test(p)) score += 14;
    if (p.includes("/models/") || p.includes("/model/")) score += 9;
    if (p.includes("/heads/") || p.includes("/layers/") || p.includes("/utils/")) score += 5;
    if (p.includes("/datasets/") || p.includes("dataloader")) score += 8;
    if (p.includes("config") && (p.endsWith(".yaml") || p.endsWith(".yml") || p.endsWith(".json"))) score += 7;
    if (p.includes("__pycache__")) score -= 100;
  }

  if (profile.kind === "frontend") {
    if (/package\.json|vite\.config|next\.config|tsconfig\.json/.test(p)) score += 12;
    if (/src\/(main|index|app)\.(ts|tsx|js|jsx)$/.test(p)) score += 14;
    if (p.includes("/pages/") || p.includes("/routes/") || p.includes("/components/") || p.includes("/api/") || p.includes("/store/")) score += 6;
  }

  return score;
}

function scoreFeatureFiles(files: TreeFile[], keywords: string[], profile: ProjectProfile): TreeFile[] {
  const scored = files
    .map((file) => {
      const lower = file.path.toLowerCase();
      let score = profilePathScore(file.path, profile) * 0.2;
      for (const keyword of keywords) {
        if (lower.includes(keyword)) score += 8;
      }
      if (lower.includes("/pages/") || lower.includes("/views/")) score += 2;
      if (lower.includes("/api/") || lower.includes("/services/") || lower.includes("/store/")) score += 2;
      if (profile.kind === "python-ml" && (lower.includes("/models/") || lower.includes("/training/") || lower.includes("/eval/"))) score += 3;
      if (lower.includes("test") || lower.includes("spec")) score += 1;
      if (lower.includes("__pycache__")) score -= 100;
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
      const clipped = truncate(content, Math.min(7000, remaining));
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
    .map(([dir, count]) => `- ${dir}: ${count} files`)
    .join("\n");
  const sampleFiles = files
    .slice(0, 140)
    .map((file) => `- ${file.path}`)
    .join("\n");
  return `Main directories:\n${dirText}\n\nSample files:\n${sampleFiles}`;
}

function formatSnippets(snippets: FileSnippet[]): string {
  return snippets.map((item) => `\n--- ${item.path} ---\n${item.content}`).join("\n");
}

function systemPrompt(profile: ProjectProfile) {
  return {
    role: "system" as const,
    content: `You are CodePath, a GitHub source-code guide for learners and secondary developers.
The user does not want to deploy or run the project. They want to understand source code ideas, feature paths, and modification routes.
Answer in clear Chinese. Use plain language, but keep file paths exact.
Only use the provided tree and source snippets. If something is inferred, label it as inference.
Detected project type: ${profile.label}.`
  };
}

function projectPrompt(profile: ProjectProfile): string {
  if (profile.kind === "python-ml") {
    return `Analyze this Python ML / research repository for a learner. Focus on:
1. One-sentence project purpose.
2. Tech stack and research/ML framework signals.
3. Directory roles.
4. Training entry points.
5. Inference/demo entry points.
6. Evaluation entry points.
7. Model architecture reading path.
8. Dataset/data-loader path.
9. Checkpoint/config path.
10. Suggested reading route for secondary development.

Do not invent files. Cite file paths for every important claim.`;
  }

  if (profile.kind === "frontend") {
    return `Analyze this frontend repository for a learner. Focus on:
1. Project purpose.
2. Tech stack.
3. App entry point.
4. Route/page structure.
5. Component structure.
6. Data/API layer.
7. State management if present.
8. Suggested reading route.

Do not invent files. Cite file paths for every important claim.`;
  }

  return `Analyze this GitHub repository. Output a plain-language project guide, tech stack, directory roles, likely entry points, and recommended reading route.
Do not invent files. Cite file paths for every important claim.`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n... content truncated ...`;
}

function uniqueByPath(files: TreeFile[]): TreeFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}
