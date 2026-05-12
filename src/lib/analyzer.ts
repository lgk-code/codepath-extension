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
  ProjectOverview,
  RepoRef,
  Settings,
  SkillBlueprint,
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

type ProjectKind = "python-ml" | "frontend" | "node-backend" | "python-app" | "generic";

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
  onModelStart?: () => void;
  onModelDelta?: (text: string) => void;
  onModelDone?: () => void;
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

const GENERIC_CONTEXT_PROFILE: ProjectProfile = {
  kind: "generic",
  label: "Cached repository context",
  confidence: "medium",
  reasons: ["Using previous CodePath analysis context"]
};

export async function analyzeProject(repo: RepoRef, settings: Settings, options: AnalysisRunOptions = {}): Promise<ProjectOverview> {
  const timing = createTiming();
  const cachedOverview = findCachedOverview(repo);
  if (cachedOverview) return withTiming(cachedOverview, timing, { cacheHit: true });

  const gh = await measure(timing, "githubMs", () => createSourceClient(repo, settings));
  const context = await measure(timing, "contextMs", () => getRepoAnalysisContext(gh, repo, timing));
  const cacheKey = overviewCacheKey(repo, context.branch);
  const cached = overviewCache.get(cacheKey);
  if (cached) return withTiming(cached, timing, { cacheHit: true });

  const persisted = await persistentGet<ProjectOverview>(persistentOverviewKey(repo, context.branch));
  if (persisted) {
    overviewCache.set(cacheKey, persisted);
    return withTiming(persisted, timing, { cacheHit: true });
  }

  const selected = pickImportantFiles(context.usefulFiles, context.profile);
  const snippets = await loadSnippetsCached(gh, repo, context.branch, selected, context.profile.kind === "python-ml" ? 22000 : 16000, timing);

  const content = await runModel(timing, settings, [
    systemPrompt(context.profile),
    {
      role: "user",
      content: `${projectPrompt(context.profile)}

Repository: ${repo.owner}/${repo.repo}
Branch: ${context.branch}

Detected project type:
- ${context.profile.label}
- Confidence: ${context.profile.confidence}
- Reasons: ${context.profile.reasons.join("; ") || "No strong signal"}

Repository tree summary:
${context.treeSummary}

Key file contents:
${formatSnippets(snippets)}`
    }
  ], options);

  const overview = { summary: content, sources: snippets.map((item) => ({ path: item.path })) };
  overviewCache.set(cacheKey, overview);
  await persistentSet(persistentOverviewKey(repo, context.branch), overview);
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

  const summary = await runModel(timing, settings, [
    systemPrompt(context.profile),
    {
      role: "user",
      content: `Explain the current file for a learner or secondary developer.

Repository: ${repo.owner}/${repo.repo}
Detected project type: ${context.profile.label}
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

  const content = await runModel(timing, settings, [
    systemPrompt(repoContext.profile),
    {
      role: "user",
      content: `The user is asking a follow-up question based on CodePath's repository guide. Answer only from the previous context and the source snippets. Do not invent files.

Repository: ${repo.owner}/${repo.repo}
Branch: ${repoContext.branch}
Detected project type: ${repoContext.profile.label}

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
      return await chatAuto(settings, messages, options.onModelDelta);
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

function overviewCacheKey(repo: RepoRef, branch: string): string {
  return `${repoCacheKey(repo, branch)}:overview`;
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

function persistentOverviewKey(repo: RepoRef, branch: string): string {
  return `${PERSISTENT_CACHE_PREFIX}${overviewCacheKey(repo, branch)}`;
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

function findCachedOverview(repo: RepoRef): ProjectOverview | undefined {
  if (repo.branch) return overviewCache.get(overviewCacheKey(repo, repo.branch));

  const prefix = `${repo.owner}/${repo.repo}@`;
  for (const [key, value] of overviewCache) {
    if (key.startsWith(prefix) && key.endsWith(":overview")) return value;
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
