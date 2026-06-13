import type {
  BlueprintMode,
  CacheClearResult,
  CacheClearScope,
  CacheDeleteResult,
  CacheEntry,
  CacheRepository,
  CacheStats,
  FileExplanation,
  FeaturePath,
  ProjectAnalysisMode,
  ProjectOverview,
  RepoRef,
  Settings,
  SkillBlueprint,
  SuggestedQuestionsResult,
  SuggestionAnalysisKind,
  TimingBreakdown,
  TreeFile
} from "../types";
import { GithubClient } from "./githubClient";
import { ZipGithubClient } from "./zipGithubClient";
import { chatAuto } from "./aiClient";
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

type ProjectKind = "python-ml" | "browser-extension" | "frontend" | "node-backend" | "python-app" | "library" | "generic";

type ProjectProfile = {
  kind: ProjectKind;
  label: string;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

type RepoAnalysisContext = {
  branch: string;
  files: TreeFile[];
  usefulFiles: TreeFile[];
  profile: ProjectProfile;
  treeSummary: string;
};

type TimingCollector = {
  startedAt: number;
  timing: TimingBreakdown;
};

type TimingNumberKey = "githubMs" | "treeMs" | "fileMs" | "contextMs" | "modelMs" | "totalMs";

type AnalysisRunOptions = {
  mode?: ProjectAnalysisMode;
  onModelStart?: () => void;
  onModelDelta?: (text: string) => void;
  onModelDone?: () => void;
  onModelFallback?: (reason: string) => void;
};

type SuggestedQuestionsInput = {
  kind: SuggestionAnalysisKind;
  label?: string;
  summary: string;
  sources: string[];
};

type BrowserStorageArea = {
  get(key: string | null, callback: (items: Record<string, unknown>) => void): void;
  set(items: Record<string, unknown>, callback: () => void): void;
  remove(keys: string[], callback: () => void): void;
};

const repoContextCache = new Map<string, RepoAnalysisContext>();
const snippetCache = new Map<string, string>();
const overviewCache = new Map<string, ProjectOverview>();
const featureCache = new Map<string, FeaturePath>();
const fileExplanationCache = new Map<string, FileExplanation>();
const questionCache = new Map<string, ProjectOverview>();
const skillBlueprintCache = new Map<string, SkillBlueprint>();
const PERSISTENT_CACHE_PREFIX = "codepath-cache:";
const FULL_SOURCE_TOTAL_LIMIT = 120_000;
const FULL_SOURCE_SINGLE_FILE_LIMIT = 40_000;

const GENERIC_CONTEXT_PROFILE: ProjectProfile = {
  kind: "generic",
  label: "Cached repository context",
  confidence: "medium",
  reasons: ["Using previous CodePath analysis context"]
};

export async function analyzeProject(repo: RepoRef, settings: Settings, options: AnalysisRunOptions = {}): Promise<ProjectOverview> {
  const mode = options.mode ?? "focused";
  const timing = createTiming();
  const cachedOverview = findCachedOverview(repo, mode);
  if (cachedOverview) return withTiming(cachedOverview, timing, { cacheHit: true });

  const gh = await measure(timing, "githubMs", () => createSourceClient(repo, settings));
  const context = await measure(timing, "contextMs", () => getRepoAnalysisContext(gh, repo, timing));
  const cacheKey = overviewCacheKey(repo, context.branch, mode);
  const cached = overviewCache.get(cacheKey);
  if (cached) return withTiming(cached, timing, { cacheHit: true });

  const persisted = await persistentGet<ProjectOverview>(persistentOverviewKey(repo, context.branch, mode));
  if (persisted) {
    overviewCache.set(cacheKey, persisted);
    return withTiming(persisted, timing, { cacheHit: true });
  }

  const snippets =
    mode === "full-source"
      ? await loadFullSourceSnippets(gh, repo, context.branch, context.usefulFiles, timing)
      : await loadSnippetsCached(gh, repo, context.branch, pickImportantFiles(context.usefulFiles, context.profile), context.profile.kind === "python-ml" ? 22000 : 16000, timing);
  const structuralContext = buildStructuralContext(context, snippets);

  const content = await runModel(timing, settings, [
    systemPrompt(context.profile),
    {
      role: "user",
      content: `${mode === "full-source" ? fullSourceProjectPrompt(context.profile, snippets) : projectPrompt(context.profile)}

Repository: ${repo.owner}/${repo.repo}
Branch: ${context.branch}

Detected project type:
- ${context.profile.label}
- Confidence: ${context.profile.confidence}
- Reasons: ${context.profile.reasons.join("; ") || "No strong signal"}

Repository tree summary:
${context.treeSummary}

Structural context:
${structuralContext}

${mode === "full-source" ? "Complete useful source contents" : "Key file contents"}:
${formatSnippets(snippets)}`
    }
  ], options);

  const overview = { summary: content, sources: snippets.map((item) => ({ path: item.path })) };
  overviewCache.set(cacheKey, overview);
  await persistentSet(persistentOverviewKey(repo, context.branch, mode), overview);
  return withTiming(overview, timing);
}

export async function analyzeFeature(repo: RepoRef, settings: Settings, feature: string, options: AnalysisRunOptions = {}): Promise<FeaturePath> {
  const timing = createTiming();
  const gh = await measure(timing, "githubMs", () => createSourceClient(repo, settings));
  const context = await measure(timing, "contextMs", () => getRepoAnalysisContext(gh, repo, timing));
  const cacheKey = featureCacheKey(repo, context.branch, feature);
  const cached = featureCache.get(cacheKey);
  if (cached) return withTiming(cached, timing, { cacheHit: true });

  const keywords = expandFeatureKeywords(feature);
  const candidates = scoreFeatureFiles(context.usefulFiles, keywords, context.profile).slice(0, 16);
  const snippets = await loadSnippetsCached(gh, repo, context.branch, candidates, 24000, timing);
  const withImports = snippets.map((snippet) => ({ ...snippet, imports: extractImports(snippet.content) }));
  const structuralContext = buildStructuralContext(context, withImports);

  const content = await runModel(timing, settings, [
    systemPrompt(context.profile),
    {
      role: "user",
      content: `The user wants to understand one feature without cloning, deploying, or running the project.

Feature: ${feature}
Repository: ${repo.owner}/${repo.repo}
Branch: ${context.branch}
Detected project type: ${context.profile.label}
Expanded keywords: ${keywords.join(", ")}

Structural context:
${structuralContext}

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
  ], options);

  const result = {
    feature,
    summary: content,
    sources: withImports.map((item) => ({ path: item.path, reason: "feature candidate" }))
  };
  featureCache.set(cacheKey, result);
  return withTiming(result, timing);
}

export async function generateSkillBlueprint(repo: RepoRef, settings: Settings, feature: string, mode: BlueprintMode, options: AnalysisRunOptions = {}): Promise<SkillBlueprint> {
  const timing = createTiming();
  const gh = await measure(timing, "githubMs", () => createSourceClient(repo, settings));
  const context = await measure(timing, "contextMs", () => getRepoAnalysisContext(gh, repo, timing));
  const cacheKey = skillBlueprintCacheKey(repo, context.branch, feature, mode);
  const cached = skillBlueprintCache.get(cacheKey);
  if (cached) return withTiming(cached, timing, { cacheHit: true });

  const keywords = expandFeatureKeywords(feature);
  const candidates = scoreFeatureFiles(context.usefulFiles, keywords, context.profile).slice(0, 18);
  const selected = candidates.length > 0 ? candidates : pickImportantFiles(context.usefulFiles, context.profile).slice(0, 18);
  const snippets = await loadSnippetsCached(gh, repo, context.branch, selected, 28000, timing);
  const withImports = snippets.map((snippet) => ({ ...snippet, imports: extractImports(snippet.content) }));
  const structuralContext = buildStructuralContext(context, withImports);

  const content = await runModel(timing, settings, [
    systemPrompt(context.profile),
    {
      role: "user",
      content: `${skillBlueprintPrompt(mode)}

Repository: ${repo.owner}/${repo.repo}
Branch: ${context.branch}
Feature: ${feature}
Detected project type: ${context.profile.label}
Expanded keywords: ${keywords.join(", ")}

Repository tree summary:
${context.treeSummary}

Structural context:
${structuralContext}

Candidate files:
${withImports.map((item) => `- ${item.path} (${classifyPath(item.path)}) imports: ${(item.imports ?? []).join(", ") || "none"}`).join("\n")}

Source snippets:
${formatSnippets(withImports)}`
    }
  ], options);

  const result = {
    feature,
    mode,
    summary: content,
    sources: withImports.map((item) => ({ path: item.path, reason: `${mode} candidate` }))
  };
  skillBlueprintCache.set(cacheKey, result);
  return withTiming(result, timing);
}

export async function explainFile(repo: RepoRef, settings: Settings, options: AnalysisRunOptions = {}): Promise<FileExplanation> {
  const timing = createTiming();
  if (!repo.path) throw new Error("The current page is not a GitHub file page.");
  const gh = await measure(timing, "githubMs", () => createSourceClient(repo, settings));
  const context = await measure(timing, "contextMs", () => getRepoAnalysisContext(gh, repo, timing));
  const cacheKey = fileExplanationCacheKey(repo, repo.branch || context.branch, repo.path);
  const cached = fileExplanationCache.get(cacheKey);
  if (cached) return withTiming(cached, timing, { cacheHit: true });

  const content = await loadFileCached(gh, repo, repo.branch || context.branch, repo.path, timing);
  const imports = extractImports(content);
  const structuralContext = buildStructuralContext(context, [{ path: repo.path, content, imports }]);

  const summary = await runModel(timing, settings, [
    systemPrompt(context.profile),
    {
      role: "user",
      content: `Explain the current file for a learner or secondary developer.

Repository: ${repo.owner}/${repo.repo}
Detected project type: ${context.profile.label}
File: ${repo.path}
Imports: ${imports.join(", ") || "none"}

Structural context:
${structuralContext}

Please explain:
1. What this file is responsible for.
2. Its main classes/functions/components.
3. Where it sits in the project.
4. What it depends on.
5. What to be careful about before editing it.

Source:
${truncate(content, 18000)}`
    }
  ], options);

  const result = { path: repo.path, summary, sources: [{ path: repo.path }] };
  fileExplanationCache.set(cacheKey, result);
  return withTiming(result, timing);
}

export async function answerQuestion(repo: RepoRef, settings: Settings, question: string, context?: string, options: AnalysisRunOptions = {}): Promise<ProjectOverview> {
  const timing = createTiming();
  if (context && context.trim().length > 500 && !needsSourceLookup(question)) {
    const cacheKey = questionCacheKey(repo, "context", question, context);
    const cached = questionCache.get(cacheKey);
    if (cached) return withTiming(cached, timing, { cacheHit: true });

    const content = await runModel(timing, settings, [
      systemPrompt(GENERIC_CONTEXT_PROFILE),
      {
        role: "user",
        content: `The user is asking a follow-up question based on CodePath's cached repository guide.
Answer from the previous context first. If the previous context is not enough, say what is missing and suggest which feature/file analysis to run next.
Do not invent files.

Repository: ${repo.owner}/${repo.repo}

Previous context:
${truncate(context, 12000)}

User question:
${question}`
      }
    ], options);

    const result = { summary: content, sources: [] };
    questionCache.set(cacheKey, result);
    return withTiming(result, timing);
  }

  const gh = await measure(timing, "githubMs", () => createSourceClient(repo, settings));
  const repoContext = await measure(timing, "contextMs", () => getRepoAnalysisContext(gh, repo, timing));
  const cacheKey = questionCacheKey(repo, repoContext.branch, question, context ?? "");
  const cached = questionCache.get(cacheKey);
  if (cached) return withTiming(cached, timing, { cacheHit: true });

  const keywords = question
    .toLowerCase()
    .split(/[\s,，。/._-]+/)
    .filter((item) => item.length >= 2)
    .slice(0, 14);
  const candidates = scoreFeatureFiles(repoContext.usefulFiles, keywords, repoContext.profile).slice(0, 14);
  const selected = candidates.length > 0 ? candidates : pickImportantFiles(repoContext.usefulFiles, repoContext.profile).slice(0, 14);
  const snippets = await loadSnippetsCached(gh, repo, repoContext.branch, selected, 22000, timing);
  const structuralContext = buildStructuralContext(repoContext, snippets);

  const content = await runModel(timing, settings, [
    systemPrompt(repoContext.profile),
    {
      role: "user",
      content: `The user is asking a follow-up question based on CodePath's repository guide. Answer only from the previous context and the source snippets. Do not invent files.

Repository: ${repo.owner}/${repo.repo}
Branch: ${repoContext.branch}
Detected project type: ${repoContext.profile.label}

Structural context:
${structuralContext}

Previous context:
${context ? truncate(context, 9000) : "None"}

User question:
${question}

Relevant source snippets:
${formatSnippets(snippets)}`
    }
  ], options);

  const result = { summary: content, sources: snippets.map((item) => ({ path: item.path })) };
  questionCache.set(cacheKey, result);
  return withTiming(result, timing);
}

export async function generateSuggestedQuestions(
  repo: RepoRef,
  settings: Settings,
  input: SuggestedQuestionsInput
): Promise<SuggestedQuestionsResult> {
  const timing = createTiming();
  const content = await runModel(timing, settings, [
    {
      role: "system",
      content: `Generate CodePath follow-up questions.
Write concise Chinese questions for learners and secondary developers.
Only use the provided analysis summary and source paths.
Do not invent files, features, frameworks, or project facts.
Return only a JSON array of exactly 3 strings.`
    },
    {
      role: "user",
      content: `Generate 3 recommended follow-up questions after this CodePath analysis.

Repository: ${repo.owner}/${repo.repo}
Branch: ${repo.branch || "default"}
Analysis kind: ${suggestionKindLabel(input.kind)}
Analysis label: ${input.label?.trim() || "none"}

Source paths that may be referenced:
${input.sources.slice(0, 40).map((source) => `- ${source}`).join("\n") || "- none"}

Analysis summary:
${truncate(input.summary, 10000)}

Requirements:
- Each question must be grounded in the analysis summary.
- Prefer questions that help the user understand code paths, responsibilities, modification risks, or next reading steps.
- If mentioning a file path, it must appear in the source paths list above.
- Do not ask generic questions that could apply to any project.
- Return only JSON, for example: ["问题一？","问题二？","问题三？"]`
    }
  ], {});

  const questions = parseSuggestedQuestions(content);
  if (questions.length === 0) {
    throw new Error("未能生成推荐追问：模型没有返回可用问题。");
  }
  return withTiming({ questions }, timing);
}

export async function clearAnalysisCaches(scope: CacheClearScope, repo?: RepoRef): Promise<CacheClearResult> {
  if (scope === "repo" && !repo) {
    return { scope, memoryCleared: false, persistentKeysCleared: 0 };
  }
  clearMemoryCaches(repo ? `${repo.owner}/${repo.repo}@` : "");
  const persistentKeysCleared = await persistentClear(repo ? persistentRepoPrefix(repo) : PERSISTENT_CACHE_PREFIX);
  return { scope, memoryCleared: true, persistentKeysCleared };
}

export async function getAnalysisCacheStats(repo?: RepoRef): Promise<CacheStats> {
  const storage = getChromeStorage();
  if (!storage) {
    return { currentRepoPersistentKeys: 0, allPersistentKeys: 0, repositories: [] };
  }

  try {
    const items = await storageGet(storage, null);
    const keys = Object.keys(items).filter((key) => key.startsWith(PERSISTENT_CACHE_PREFIX));
    const repoPrefix = repo ? persistentRepoPrefix(repo) : "";
    const repositories = groupPersistentCacheKeys(keys);
    return {
      currentRepoPersistentKeys: repoPrefix ? keys.filter((key) => key.startsWith(repoPrefix)).length : 0,
      allPersistentKeys: keys.length,
      repositories
    };
  } catch {
    return { currentRepoPersistentKeys: 0, allPersistentKeys: 0, repositories: [] };
  }
}

export async function deletePersistentCacheEntry(key: string): Promise<CacheDeleteResult> {
  const storage = getChromeStorage();
  if (!storage || !key.startsWith(PERSISTENT_CACHE_PREFIX)) {
    return { target: "entry", memoryCleared: false, persistentKeysCleared: 0 };
  }

  const entry = parsePersistentCacheKey(key);
  if (entry) clearMemoryCaches(`${entry.owner}/${entry.repo}@${entry.branch}`);
  const existing = await storageGet(storage, key);
  await storageRemove(storage, [key]);
  return { target: "entry", memoryCleared: Boolean(entry), persistentKeysCleared: Object.prototype.hasOwnProperty.call(existing, key) ? 1 : 0 };
}

export async function deletePersistentCacheRepo(repoKey: string): Promise<CacheDeleteResult> {
  const storage = getChromeStorage();
  if (!storage || !repoKey) {
    return { target: "repo", memoryCleared: false, persistentKeysCleared: 0 };
  }

  clearMemoryCaches(repoKey);
  const persistentKeysCleared = await persistentClear(`${PERSISTENT_CACHE_PREFIX}${repoKey}:`);
  return { target: "repo", memoryCleared: true, persistentKeysCleared };
}

function createTiming(): TimingCollector {
  return { startedAt: Date.now(), timing: {} };
}

async function measure<T>(collector: TimingCollector | undefined, key: TimingNumberKey, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    if (collector) collector.timing[key] = (collector.timing[key] ?? 0) + Date.now() - startedAt;
  }
}

async function runModel(
  collector: TimingCollector,
  settings: Settings,
  messages: Array<{ role: "system" | "user"; content: string }>,
  options: AnalysisRunOptions
): Promise<string> {
  return measure(collector, "modelMs", async () => {
    const willStream = settings.supportsStreaming === true && Boolean(options.onModelDelta);
    if (willStream) options.onModelStart?.();
    try {
      return await chatAuto(settings, messages, options.onModelDelta, options.onModelFallback);
    } finally {
      if (willStream) options.onModelDone?.();
    }
  });
}

function withTiming<T extends object>(
  value: T,
  collector: TimingCollector,
  patch: Partial<TimingBreakdown> = {}
): T & { timing: TimingBreakdown } {
  return {
    ...value,
    timing: {
      ...("timing" in value && typeof value.timing === "object" ? value.timing : {}),
      ...collector.timing,
      ...patch,
      totalMs: Date.now() - collector.startedAt
    }
  };
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

async function loadTree(gh: SourceClient, repo: RepoRef, timing?: TimingCollector): Promise<{ branch: string; files: TreeFile[] }> {
  const info = await measure(timing, "githubMs", () => gh.getRepo(repo.owner, repo.repo));
  const branch = repo.branch || info.default_branch;
  const files = await measure(timing, "treeMs", () => gh.getTree(repo.owner, repo.repo, branch));
  return { branch, files };
}

async function getRepoAnalysisContext(gh: SourceClient, repo: RepoRef, timing?: TimingCollector): Promise<RepoAnalysisContext> {
  const provisionalKey = repoCacheKey(repo, repo.branch || "default");
  const provisional = repoContextCache.get(provisionalKey);
  if (provisional) return provisional;

  const { branch, files } = await loadTree(gh, repo, timing);
  const key = repoCacheKey(repo, branch);
  const cached = repoContextCache.get(key);
  if (cached) return cached;

  const persisted = await persistentGet<RepoAnalysisContext>(persistentTreeKey(repo, branch));
  if (persisted) {
    repoContextCache.set(key, persisted);
    if (!repo.branch) repoContextCache.set(provisionalKey, persisted);
    return persisted;
  }

  const usefulFiles = files.filter((file) => file.type === "blob" && isUsefulPath(file.path));
  const profile = detectProjectProfile(usefulFiles);
  const treeSummary = summarizeTree(usefulFiles);
  const context = { branch, files, usefulFiles, profile, treeSummary };
  repoContextCache.set(key, context);
  if (!repo.branch) repoContextCache.set(provisionalKey, context);
  await persistentSet(persistentTreeKey(repo, branch), context);
  return context;
}

async function loadSnippetsCached(
  gh: SourceClient,
  repo: RepoRef,
  branch: string,
  files: TreeFile[],
  budget: number,
  timing?: TimingCollector
): Promise<FileSnippet[]> {
  const snippets: FileSnippet[] = [];
  let used = 0;
  for (const file of files) {
    if (used >= budget) break;
    if ((file.size ?? 0) > 180_000) continue;
    try {
      const content = await loadFileCached(gh, repo, branch, file.path, timing);
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

async function loadFullSourceSnippets(
  gh: SourceClient,
  repo: RepoRef,
  branch: string,
  files: TreeFile[],
  timing?: TimingCollector
): Promise<FileSnippet[]> {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const oversizedFile = sorted.find((file) => (file.size ?? 0) > FULL_SOURCE_SINGLE_FILE_LIMIT);
  if (oversizedFile) throw fullSourceSizeError(`单文件 ${oversizedFile.path} 大小超过 ${FULL_SOURCE_SINGLE_FILE_LIMIT}。`);

  const estimatedTotal = sorted.reduce((sum, file) => sum + (file.size ?? 0), 0);
  if (estimatedTotal > FULL_SOURCE_TOTAL_LIMIT) {
    throw fullSourceSizeError(`可用源码总大小约 ${estimatedTotal}，超过 ${FULL_SOURCE_TOTAL_LIMIT}。`);
  }

  const snippets: FileSnippet[] = [];
  let used = 0;
  for (const file of sorted) {
    let content: string;
    try {
      content = await loadFileCached(gh, repo, branch, file.path, timing);
    } catch (error) {
      throw new Error(`全部源码分析读取失败：${file.path}。${error instanceof Error ? error.message : String(error)}`);
    }

    if (content.length > FULL_SOURCE_SINGLE_FILE_LIMIT) {
      throw fullSourceSizeError(`单文件 ${file.path} 内容长度超过 ${FULL_SOURCE_SINGLE_FILE_LIMIT}。`);
    }
    if (used + content.length > FULL_SOURCE_TOTAL_LIMIT) {
      throw fullSourceSizeError(`可用源码总长度超过 ${FULL_SOURCE_TOTAL_LIMIT}。`);
    }
    used += content.length;
    snippets.push({ path: file.path, content });
  }
  return snippets;
}

function fullSourceSizeError(detail: string): Error {
  return new Error(`全部源码分析超过限制：${detail}请改用“根据当前分析情况”，或使用功能路径/当前文件分析缩小范围。`);
}

async function loadFileCached(gh: SourceClient, repo: RepoRef, branch: string, path: string, timing?: TimingCollector): Promise<string> {
  const key = fileCacheKey(repo, branch, path);
  const cached = snippetCache.get(key);
  if (cached !== undefined) return cached;
  const persisted = await persistentGet<string>(persistentFileKey(repo, branch, path));
  if (persisted !== undefined) {
    snippetCache.set(key, persisted);
    return persisted;
  }
  const content = await measure(timing, "fileMs", () => gh.getFile(repo.owner, repo.repo, path, branch));
  snippetCache.set(key, content);
  if (content.length <= 180_000) await persistentSet(persistentFileKey(repo, branch, path), content);
  return content;
}

function repoCacheKey(repo: RepoRef, branch: string): string {
  return `${repo.owner}/${repo.repo}@${branch}`;
}

function overviewCacheKey(repo: RepoRef, branch: string, mode: ProjectAnalysisMode = "focused"): string {
  return mode === "focused" ? `${repoCacheKey(repo, branch)}:overview` : `${repoCacheKey(repo, branch)}:overview:${mode}`;
}

function featureCacheKey(repo: RepoRef, branch: string, feature: string): string {
  return `${repoCacheKey(repo, branch)}:feature:${normalizeCacheText(feature)}`;
}

function fileExplanationCacheKey(repo: RepoRef, branch: string, path: string): string {
  return `${repoCacheKey(repo, branch)}:explain:${path}`;
}

function questionCacheKey(repo: RepoRef, branch: string, question: string, context: string): string {
  return `${repoCacheKey(repo, branch)}:question:${normalizeCacheText(question)}:${stringHash(context.slice(0, 16000))}`;
}

function skillBlueprintCacheKey(repo: RepoRef, branch: string, feature: string, mode: BlueprintMode): string {
  return `${repoCacheKey(repo, branch)}:blueprint:${mode}:${normalizeCacheText(feature)}`;
}

function fileCacheKey(repo: RepoRef, branch: string, path: string): string {
  return `${repoCacheKey(repo, branch)}:${path}`;
}

function persistentRepoPrefix(repo: RepoRef): string {
  return `${PERSISTENT_CACHE_PREFIX}${repo.owner}/${repo.repo}@`;
}

function persistentTreeKey(repo: RepoRef, branch: string): string {
  return `${PERSISTENT_CACHE_PREFIX}${repoCacheKey(repo, branch)}:tree`;
}

function persistentFileKey(repo: RepoRef, branch: string, path: string): string {
  return `${PERSISTENT_CACHE_PREFIX}${fileCacheKey(repo, branch, path)}`;
}

function persistentOverviewKey(repo: RepoRef, branch: string, mode: ProjectAnalysisMode = "focused"): string {
  return `${PERSISTENT_CACHE_PREFIX}${overviewCacheKey(repo, branch, mode)}`;
}

function clearMemoryCaches(prefix: string) {
  clearMap(repoContextCache, prefix);
  clearMap(snippetCache, prefix);
  clearMap(overviewCache, prefix);
  clearMap(featureCache, prefix);
  clearMap(fileExplanationCache, prefix);
  clearMap(questionCache, prefix);
  clearMap(skillBlueprintCache, prefix);
}

function clearMap<T>(map: Map<string, T>, prefix: string) {
  if (!prefix) {
    map.clear();
    return;
  }
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) map.delete(key);
  }
}

async function persistentGet<T>(key: string): Promise<T | undefined> {
  const storage = getChromeStorage();
  if (!storage) return undefined;
  try {
    const items = await storageGet(storage, key);
    return items[key] as T | undefined;
  } catch {
    return undefined;
  }
}

async function persistentSet(key: string, value: unknown): Promise<void> {
  const storage = getChromeStorage();
  if (!storage) return;
  try {
    await storageSet(storage, { [key]: value });
  } catch {
    // Persistent cache is a best-effort optimization; analysis should still work without it.
  }
}

async function persistentClear(prefix: string): Promise<number> {
  const storage = getChromeStorage();
  if (!storage) return 0;
  try {
    const items = await storageGet(storage, null);
    const keys = Object.keys(items).filter((key) => key.startsWith(prefix));
    if (keys.length > 0) await storageRemove(storage, keys);
    return keys.length;
  } catch {
    return 0;
  }
}

function groupPersistentCacheKeys(keys: string[]): CacheRepository[] {
  const repositories = new Map<string, CacheRepository>();
  for (const key of keys) {
    const entry = parsePersistentCacheKey(key);
    if (!entry) continue;
    const repoKey = `${entry.owner}/${entry.repo}@${entry.branch}`;
    const repository = repositories.get(repoKey) ?? {
      repoKey,
      owner: entry.owner,
      repo: entry.repo,
      branch: entry.branch,
      count: 0,
      items: []
    };
    repository.items.push({ key, kind: entry.kind, label: entry.label });
    repository.count = repository.items.length;
    repositories.set(repoKey, repository);
  }

  return [...repositories.values()]
    .map((repository) => ({
      ...repository,
      items: repository.items.sort((left, right) => cacheEntryRank(left) - cacheEntryRank(right) || left.label.localeCompare(right.label))
    }))
    .sort((left, right) => left.repoKey.localeCompare(right.repoKey));
}

function parsePersistentCacheKey(key: string): ({ owner: string; repo: string; branch: string } & CacheEntry) | undefined {
  if (!key.startsWith(PERSISTENT_CACHE_PREFIX)) return undefined;
  const rest = key.slice(PERSISTENT_CACHE_PREFIX.length);
  const delimiterIndex = rest.indexOf(":");
  if (delimiterIndex < 0) return undefined;

  const repoBranch = rest.slice(0, delimiterIndex);
  const suffix = rest.slice(delimiterIndex + 1);
  const atIndex = repoBranch.lastIndexOf("@");
  const slashIndex = repoBranch.indexOf("/");
  if (slashIndex <= 0 || atIndex <= slashIndex + 1) return undefined;

  const owner = repoBranch.slice(0, slashIndex);
  const repo = repoBranch.slice(slashIndex + 1, atIndex);
  const branch = repoBranch.slice(atIndex + 1);
  const item = parseCacheItemSuffix(key, suffix);
  return { owner, repo, branch, ...item };
}

function parseCacheItemSuffix(key: string, suffix: string): CacheEntry {
  if (suffix === "tree") return { key, kind: "tree", label: "tree" };
  if (suffix === "overview") return { key, kind: "overview", label: "overview" };
  if (!suffix.includes(":")) return { key, kind: "file", label: `file: ${suffix}` };
  return { key, kind: "unknown", label: suffix || "unknown" };
}

function cacheEntryRank(entry: CacheEntry): number {
  if (entry.kind === "tree") return 0;
  if (entry.kind === "overview") return 1;
  if (entry.kind === "file") return 2;
  return 3;
}

function getChromeStorage(): BrowserStorageArea | undefined {
  const maybeGlobal = globalThis as typeof globalThis & {
    chrome?: { storage?: { local?: BrowserStorageArea }; runtime?: { lastError?: { message?: string } } };
  };
  return maybeGlobal.chrome?.storage?.local;
}

function getChromeLastError(): { message?: string } | undefined {
  const maybeGlobal = globalThis as typeof globalThis & { chrome?: { runtime?: { lastError?: { message?: string } } } };
  return maybeGlobal.chrome?.runtime?.lastError;
}

function storageGet(storage: BrowserStorageArea, key: string | null): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    storage.get(key, (items) => {
      const error = getChromeLastError();
      if (error) reject(new Error(error.message));
      else resolve(items as Record<string, unknown>);
    });
  });
}

function storageSet(storage: BrowserStorageArea, items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    storage.set(items, () => {
      const error = getChromeLastError();
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function storageRemove(storage: BrowserStorageArea, keys: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    storage.remove(keys, () => {
      const error = getChromeLastError();
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function findCachedOverview(repo: RepoRef, mode: ProjectAnalysisMode): ProjectOverview | undefined {
  if (repo.branch) return overviewCache.get(overviewCacheKey(repo, repo.branch, mode));

  const prefix = `${repo.owner}/${repo.repo}@`;
  for (const [key, value] of overviewCache) {
    if (key.startsWith(prefix) && key.endsWith(mode === "focused" ? ":overview" : `:overview:${mode}`)) return value;
  }
  return undefined;
}

function normalizeCacheText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
}

function stringHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function needsSourceLookup(question: string): boolean {
  const lower = question.toLowerCase();
  const asksForSource =
    /[\u5177\u4f53\u6e90\u7801\u51fd\u6570\u7c7b\u5b9e\u73b0\u6587\u4ef6\u5165\u53e3\u8c03\u7528\u4f9d\u8d56]/.test(question);
  return /(?:^|[\s/])[\w.-]+\.(?:py|ts|tsx|js|jsx|vue|go|rs|java|json|ya?ml|toml|md)\b/.test(lower) || asksForSource;
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

  if (has("package.json") && (has("wxt.config") || has("entrypoints/") || has("manifest.json"))) {
    const extensionReasons = ["package.json plus browser extension entry/config files"];
    if (has("wxt.config")) extensionReasons.push("WXT config detected");
    if (has("entrypoints/")) extensionReasons.push("extension entrypoints detected");
    if (has("src/components/")) extensionReasons.push("sidebar/components directory detected");
    if (has("scripts/codepath-mcp")) extensionReasons.push("MCP server script detected");
    return {
      kind: "browser-extension",
      label: "Browser extension / WXT project",
      confidence: has("wxt.config") || has("entrypoints/") ? "high" : "medium",
      reasons: extensionReasons
    };
  }

  if (has("package.json") && (has("src/") || has("app/") || has("pages/") || has("vite.config") || has("next.config"))) {
    const frontendReasons = ["package.json plus frontend source/config files"];
    if (has("vite.config")) frontendReasons.push("Vite config detected");
    if (has("next.config")) frontendReasons.push("Next.js config detected");
    if (has("src/components/") || has("components/")) frontendReasons.push("component directory detected");
    return {
      kind: "frontend",
      label: "Frontend JavaScript/TypeScript project",
      confidence: has("vite.config") || has("next.config") ? "high" : "medium",
      reasons: frontendReasons
    };
  }

  if (has("package.json") && (has("server") || has("express") || has("fastify") || has("nestjs") || has("routes/") || has("middleware/"))) {
    return {
      kind: "node-backend",
      label: "Node.js backend project",
      confidence: "medium",
      reasons: ["package.json plus backend naming signals"]
    };
  }

  if (has("package.json") || has("pyproject.toml") || has("setup.py") || has("cargo.toml") || has("go.mod")) {
    if (has("src/") || has("lib/") || has("packages/") || has("pkg/")) {
      return {
        kind: "library",
        label: "Library or reusable package",
        confidence: "medium",
        reasons: ["package metadata plus reusable source directories"]
      };
    }
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

  if (profile.kind === "browser-extension") {
    if (/package\.json|wxt\.config|tsconfig\.json/.test(p)) score += 12;
    if (p.startsWith("entrypoints/")) score += 16;
    if (p === "entrypoints/content.tsx" || p === "entrypoints/background.ts") score += 8;
    if (p.includes("sidebar.tsx")) score += 14;
    if (p.startsWith("src/lib/")) score += 9;
    if (p.includes("analyzer") || p.includes("aiclient") || p.includes("githubclient")) score += 8;
    if (p.includes("codepath-mcp")) score += 12;
    if (p.includes("cache") || p.includes("storage")) score += 5;
  }

  if (profile.kind === "node-backend") {
    if (/package\.json|tsconfig\.json|server\.(ts|js)|app\.(ts|js)|index\.(ts|js)/.test(p)) score += 12;
    if (p.includes("/routes/") || p.includes("/middleware/") || p.includes("/controllers/") || p.includes("/services/")) score += 8;
    if (p.includes("/test") || p.includes("/examples/")) score += 3;
  }

  if (profile.kind === "python-app") {
    if (/pyproject\.toml|requirements\.txt|setup\.py|main\.py|app\.py|__main__\.py/.test(p)) score += 12;
    if (p.includes("/cli/") || p.includes("/api/") || p.includes("/services/") || p.includes("/tests/")) score += 5;
  }

  if (profile.kind === "library") {
    if (/package\.json|pyproject\.toml|setup\.py|cargo\.toml|go\.mod|readme\.md/.test(p)) score += 12;
    if (p.includes("/src/") || p.includes("/lib/") || p.includes("/packages/") || p.includes("/pkg/")) score += 8;
    if (p.includes("/test") || p.includes("/examples/") || p.includes("/docs/")) score += 3;
  }

  return score;
}

function scoreFeatureFiles(files: TreeFile[], keywords: string[], profile: ProjectProfile): TreeFile[] {
  const entryPaths = new Set(pickEntryCandidates(files, profile).map((file) => file.path));
  const scored = files
    .map((file) => {
      const lower = file.path.toLowerCase();
      let score = profilePathScore(file.path, profile) * 0.2;
      for (const keyword of keywords) {
        if (lower.includes(keyword)) score += 8;
      }
      if (entryPaths.has(file.path)) score += 4;
      score += featureIntentScore(lower, keywords, profile);
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

function featureIntentScore(path: string, keywords: string[], profile: ProjectProfile): number {
  const joined = keywords.join(" ");
  let score = 0;

  if (/(训练|train|training|trainer|dataset|dataloader|评估|evaluate|eval|推理|inference)/i.test(joined)) {
    if (/(^|\/)(train|training|trainer|launch|main)[\w.-]*\.py$/.test(path)) score += 12;
    if (path.includes("/training/") || path.includes("/datasets/") || path.includes("dataloader")) score += 10;
    if (path.includes("/eval/") || path.includes("evaluate") || path.includes("visualization")) score += 7;
    if (path.includes("config") && /\.(ya?ml|json|toml)$/.test(path)) score += 5;
  }

  if (/(mcp|openclaw|skill|blueprint|工具|注册|server)/i.test(joined)) {
    if (path.includes("codepath-mcp")) score += 16;
    if (path.includes("analyzer")) score += 8;
    if (path.includes("types.ts")) score += 5;
    if (path.includes("openclaw") || path.includes("mcp_usage")) score += 4;
  }

  if (/(缓存|cache|storage|持久化|删除|清理)/i.test(joined)) {
    if (path.includes("analyzer")) score += 10;
    if (path.includes("sidebar")) score += 8;
    if (path.includes("background")) score += 6;
    if (path.includes("types.ts")) score += 5;
  }

  if (/(侧边栏|sidebar|浏览器|extension|content|background|wxt|插件)/i.test(joined)) {
    if (path.includes("sidebar")) score += 14;
    if (path.startsWith("entrypoints/")) score += 12;
    if (path.includes("wxt.config")) score += 6;
    if (path.includes("styles.css")) score += 4;
  }

  if (profile.kind === "browser-extension" && path.includes("entrypoints/")) score += 3;
  return score;
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

function buildStructuralContext(context: RepoAnalysisContext, snippets: FileSnippet[]): string {
  const entryCandidates = pickEntryCandidates(context.usefulFiles, context.profile).slice(0, 10);
  const configCandidates = context.usefulFiles
    .filter((file) => /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|environment\.ya?ml|vite\.config|next\.config|wxt\.config|tsconfig\.json|go\.mod|cargo\.toml|setup\.py|config[\w.-]*\.(json|ya?ml|toml))$/i.test(file.path))
    .slice(0, 12);
  const importantDirs = summarizeImportantDirs(context.usefulFiles).slice(0, 12);
  const importRelations = buildImportRelations(snippets, context.usefulFiles).slice(0, 18);
  return [
    `Project type: ${context.profile.label} (${context.profile.confidence})`,
    `Type signals: ${context.profile.reasons.join("; ") || "No strong signal"}`,
    `Entry candidates:\n${entryCandidates.map((file) => `- ${file.path}`).join("\n") || "- none detected"}`,
    `Key config/package files:\n${configCandidates.map((file) => `- ${file.path}`).join("\n") || "- none detected"}`,
    `Important directories:\n${importantDirs.map(([dir, count]) => `- ${dir}: ${count} useful files`).join("\n") || "- none detected"}`,
    `Import relationships from selected snippets:\n${importRelations.join("\n") || "- none detected"}`
  ].join("\n\n");
}

function pickEntryCandidates(files: TreeFile[], profile: ProjectProfile): TreeFile[] {
  const patterns: RegExp[] = [
    /(^|\/)(main|index|app|server|cli|__main__)\.(ts|tsx|js|jsx|py|go|rs)$/i,
    /(^|\/)(train|training|trainer|launch|infer|inference|eval|evaluate|demo)[\w.-]*\.py$/i,
    /(^|\/)(vite\.config|next\.config|wxt\.config|package\.json|pyproject\.toml)$/i
  ];
  if (profile.kind === "frontend") patterns.unshift(/src\/(main|index|app)\.(ts|tsx|js|jsx)$/i);
  if (profile.kind === "browser-extension") {
    patterns.unshift(
      /^entrypoints\/(content|background|popup|sidepanel)\.(ts|tsx|js|jsx)$/i,
      /^src\/components\/sidebar\.(ts|tsx|js|jsx)$/i,
      /^scripts\/codepath-mcp\.(ts|js)$/i
    );
  }
  if (profile.kind === "node-backend") patterns.unshift(/(^|\/)(server|app|index)\.(ts|js)$/i);
  return files.filter((file) => patterns.some((pattern) => pattern.test(file.path))).slice(0, 20);
}

function summarizeImportantDirs(files: TreeFile[]): Array<[string, number]> {
  const dirs = new Map<string, number>();
  for (const file of files) {
    const parts = file.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join("/") : "(root)";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  return [...dirs.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function buildImportRelations(snippets: FileSnippet[], files: TreeFile[]): string[] {
  const paths = files.map((file) => file.path);
  return snippets
    .map((snippet) => {
      const imports = snippet.imports ?? extractImports(snippet.content);
      if (imports.length === 0) return "";
      const resolved = imports.slice(0, 8).map((specifier) => formatImportRelation(snippet.path, specifier, paths));
      return `- ${snippet.path} imports ${resolved.join(", ")}`;
    })
    .filter(Boolean);
}

function formatImportRelation(fromPath: string, specifier: string, repoPaths: string[]): string {
  const resolved = resolveImportPath(fromPath, specifier, repoPaths);
  return resolved ? `${specifier} -> ${resolved}` : specifier;
}

function resolveImportPath(fromPath: string, specifier: string, repoPaths: string[]): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const normalized = normalizePath(`${fromDir}/${specifier}`);
  const candidates = [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}.py`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
    `${normalized}/index.jsx`,
    `${normalized}/__init__.py`
  ];
  return candidates.find((candidate) => repoPaths.includes(candidate));
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function formatSnippets(snippets: FileSnippet[]): string {
  return snippets.map((item) => `\n--- ${item.path} ---\n${item.content}`).join("\n");
}

function suggestionKindLabel(kind: SuggestionAnalysisKind): string {
  if (kind === "overview") return "项目概览";
  if (kind === "feature") return "功能路径";
  if (kind === "file") return "当前文件";
  return "借鉴 / Skill";
}

function parseSuggestedQuestions(content: string): string[] {
  return uniqueSuggestionQuestions([...parseSuggestionJson(content), ...parseSuggestionLines(content)]).slice(0, 3);
}

function parseSuggestionJson(content: string): string[] {
  const cleaned = stripMarkdownFence(content);
  const candidates = [cleaned, extractJsonArray(cleaned)].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) return parsed.map((value) => cleanSuggestionQuestion(value));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { questions?: unknown }).questions)) {
        return (parsed as { questions: unknown[] }).questions.map((value) => cleanSuggestionQuestion(value));
      }
    } catch {
      // Fall back to numbered or bulleted text parsing.
    }
  }

  return [];
}

function parseSuggestionLines(content: string): string[] {
  return stripMarkdownFence(content)
    .split(/\r?\n/)
    .map((line) => cleanSuggestionQuestion(line.replace(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)/, "")));
}

function cleanSuggestionQuestion(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[，,]\s*$/g, "？")
    .trim();
}

function stripMarkdownFence(value: string): string {
  return value.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

function extractJsonArray(value: string): string | undefined {
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  return value.slice(start, end + 1);
}

function uniqueSuggestionQuestions(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const question = value.trim();
    if (question.length < 4 || !/[?？]$/.test(question) || seen.has(question)) return false;
    seen.add(question);
    return true;
  });
}

function systemPrompt(profile: ProjectProfile) {
  return {
    role: "system" as const,
    content: `直接输出 GitHub 源码分析，不要介绍自己，不要说明 AI、模型、助手或 CodePath 身份。
The user does not want to deploy or run the project. They want to understand source code ideas, feature paths, and modification routes.
Answer in clear Chinese. Use plain language, but keep file paths exact.
Only use the provided tree, structural context, and source snippets.
Use stable sections named: 源码确认, 谨慎推断, 建议继续验证. Do not present inference as fact.
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

  if (profile.kind === "browser-extension") {
    return `Analyze this browser extension / WXT repository for a learner. Focus on:
1. Extension purpose.
2. Tech stack and extension framework signals.
3. Content/background/side panel entry points.
4. React sidebar UI structure.
5. Runtime messaging and model/GitHub data flow.
6. MCP or agent integration if present.
7. Cache/settings/error handling paths.
8. Suggested reading route for secondary development.

Do not invent files. Cite file paths for every important claim.`;
  }

  if (profile.kind === "node-backend") {
    return `Analyze this Node.js backend repository for a learner. Focus on:
1. Project purpose.
2. Server/application entry point.
3. Route and middleware flow.
4. Request/response handling path.
5. Error handling and tests/examples if present.
6. Suggested reading route for secondary development.

Do not invent files. Cite file paths for every important claim.`;
  }

  if (profile.kind === "python-app") {
    return `Analyze this Python application for a learner. Focus on:
1. Project purpose.
2. Runtime entry point.
3. Configuration and dependency files.
4. Core modules and service/data flow.
5. Tests/examples if present.
6. Suggested reading route for secondary development.

Do not invent files. Cite file paths for every important claim.`;
  }

  if (profile.kind === "library") {
    return `Analyze this reusable package/library for a learner. Focus on:
1. Package purpose.
2. Public entry points and exported modules.
3. Internal module responsibilities.
4. Examples/tests/docs reading path.
5. What to reuse or adapt in a new project.

Do not invent files. Cite file paths for every important claim.`;
  }

  return `Analyze this GitHub repository. Output a plain-language project guide, tech stack, directory roles, likely entry points, and recommended reading route.
Do not invent files. Cite file paths for every important claim.`;
}

function fullSourceProjectPrompt(profile: ProjectProfile, snippets: FileSnippet[]): string {
  return `${projectPrompt(profile)}

This run is full-source analysis over every useful text source file that passed CodePath's repository filters.
Use the complete useful source contents below as the analysis basis.
Do not claim binary assets, ignored dependency folders, lock files, or generated build outputs were analyzed.
Mention that this is 全部源码分析 only when it helps distinguish the evidence base.

Useful source files included:
${snippets.map((snippet) => `- ${snippet.path}`).join("\n") || "- none"}`;
}

function skillBlueprintPrompt(mode: BlueprintMode): string {
  const common = `Analyze one feature from this GitHub repository and turn it into reusable engineering knowledge.
Answer in Chinese.
Only use the provided repository tree and source snippets.
Do not copy large source code blocks.
Every important file path must come from the provided candidate files or tree.
Separate source-confirmed facts from cautious engineering inference.`;

  if (mode === "openclaw-skill") {
    return `${common}

Output a Markdown handoff for OpenClaw-compatible agents. Use this exact structure:

# OpenClaw 任务交接

## 任务目标
## 来源项目
## 分析功能
## 功能技术栈
## 源码确认的实现路径
## 关键文件
## 可迁移设计
## 不应照搬的内容
## OpenClaw 执行步骤
## 适合派生的 Sub-agents
## 需要向用户确认的问题
## 风险与验证建议`;
  }

  if (mode === "new-project") {
    return `${common}

Output a Markdown blueprint for implementing a similar feature in a new project. Use this structure:

# 新项目实现蓝图

## 目标功能
## 来源项目启发
## 推荐技术栈
## 推荐目录结构
## 模块职责划分
## 数据结构和接口草案
## 实现步骤
## 测试与验证
## 可迁移模式
## 不能照搬的细节
## 需要用户确认的问题`;
  }

  return `${common}

Output a human-readable technical analysis. Use this structure:

# 功能技术分析

## 功能目标
## 技术栈
## 实现路径
## 关键文件
## 数据流或调用链
## 可迁移思路
## 源码确认与谨慎推断
## 二次开发建议`;
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
