export type Provider = "openai" | "anthropic";
export type StreamingMode = "realtime" | "buffered" | "unsupported" | "untested";

export type Settings = {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  githubToken?: string;
  supportsStreaming?: boolean;
  streamingMode?: StreamingMode;
  maxOutputTokens?: number;
};

export type ModelOption = {
  id: string;
};

export type ModelListResult = {
  baseUrl: string;
  models: ModelOption[];
  selectedModel: string;
  message?: string;
};

export type RepoRef = {
  owner: string;
  repo: string;
  branch?: string;
  path?: string;
  pageType: "repo" | "file" | "directory" | "pull" | "unknown";
};

export type TreeFile = {
  path: string;
  type: "blob" | "tree";
  sha?: string;
  size?: number;
};

export type SourceRef = {
  path: string;
  reason?: string;
  blobSha?: string;
};

export type SourceClientKind = "github-api" | "github-zip";

export type SourceClient = {
  kind: SourceClientKind;
  getRepo(owner: string, repo: string): Promise<{ default_branch: string }>;
  getTree(owner: string, repo: string, branch: string): Promise<TreeFile[]>;
  getFile(owner: string, repo: string, path: string, ref: string): Promise<string>;
  getBranchSnapshot(owner: string, repo: string, branch: string): Promise<RepoSnapshot>;
};

export type CacheStatus = "fresh" | "same-tree-new-head" | "stale" | "unchecked";

export type RepoSnapshot = {
  owner: string;
  repo: string;
  refName: string;
  headSha: string;
  treeSha: string;
  capturedAt: string;
  lastValidatedAt?: string;
};

export type AnalysisBasis = {
  snapshot: RepoSnapshot;
  files: Array<{ path: string; blobSha?: string; size?: number }>;
  inputDigest: string;
  promptVersion: string;
  analyzerVersion: string;
};

export type CacheRecordKind = "tree" | "overview" | "feature" | "file" | "question" | "blueprint";

export type CacheRecord<T> = {
  schemaVersion: number;
  kind: CacheRecordKind;
  value: T;
  basis: AnalysisBasis;
};

export type TimingBreakdown = {
  githubMs?: number;
  treeMs?: number;
  fileMs?: number;
  contextMs?: number;
  modelMs?: number;
  totalMs?: number;
  cacheHit?: boolean;
  resultCacheHit?: boolean;
  sourceCacheHit?: boolean;
  sourceIncomplete?: boolean;
  skippedSourcePaths?: string[];
  persistentCacheHit?: boolean;
  sourceClient?: SourceClientKind;
  cacheStatus?: CacheStatus;
  headSha?: string;
  treeSha?: string;
  capturedAt?: string;
  lastValidatedAt?: string;
};

export type ProjectOverview = {
  summary: string;
  sources: SourceRef[];
  branch?: string;
  basis?: AnalysisBasis;
  timing?: TimingBreakdown;
};

export type ProjectAnalysisMode = "focused" | "full-source";

export type FeaturePath = {
  feature: string;
  summary: string;
  sources: SourceRef[];
  branch?: string;
  basis?: AnalysisBasis;
  timing?: TimingBreakdown;
};

export type BlueprintMode = "human" | "openclaw-skill" | "new-project";

export type SkillBlueprint = {
  feature: string;
  mode: BlueprintMode;
  summary: string;
  sources: SourceRef[];
  branch?: string;
  basis?: AnalysisBasis;
  timing?: TimingBreakdown;
};

export type FileExplanation = {
  path: string;
  summary: string;
  sources: SourceRef[];
  branch?: string;
  basis?: AnalysisBasis;
  timing?: TimingBreakdown;
};

export type SuggestionAnalysisKind = "overview" | "feature" | "file" | "skill" | "answer";

export type SuggestedQuestionsResult = {
  questions: string[];
  timing?: TimingBreakdown;
};

export type SettingsDiagnostics = {
  provider: Provider;
  apiKeyPreview: string;
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
  githubTokenPreview: string;
  hasGithubToken: boolean;
  repoCheck?: string;
  modelCheck?: string;
  streamingCheck?: string;
  supportsStreaming?: boolean;
  streamingMode?: StreamingMode;
  streamFirstDeltaMs?: number;
  streamDeltaCount?: number;
};

export type CacheClearScope = "repo" | "all";

export type CacheClearResult = {
  scope: CacheClearScope;
  memoryCleared: boolean;
  persistentKeysCleared: number;
};

export type CacheEntryKind = "tree" | "overview" | "feature" | "question" | "blueprint" | "file" | "unknown";

export type CacheEntry = {
  key: string;
  kind: CacheEntryKind;
  label: string;
};

export type CacheRepository = {
  repoKey: string;
  owner: string;
  repo: string;
  branch: string;
  count: number;
  items: CacheEntry[];
};

export type CacheStats = {
  currentRepoPersistentKeys: number;
  allPersistentKeys: number;
  repositories: CacheRepository[];
};

export type CacheDeleteResult = {
  target: "entry" | "repo";
  memoryCleared: boolean;
  persistentKeysCleared: number;
};

export type RuntimeRequest =
  | { type: "get-settings" }
  | { type: "save-settings"; settings: Settings }
  | { type: "list-models"; settings: Settings }
  | { type: "test-settings"; repo?: RepoRef }
  | { type: "clear-cache"; scope: CacheClearScope; repo?: RepoRef }
  | { type: "cache-stats"; repo?: RepoRef }
  | { type: "delete-cache-entry"; key: string }
  | { type: "delete-cache-repo"; repoKey: string }
  | { type: "analyze-project"; repo: RepoRef; mode?: ProjectAnalysisMode }
  | { type: "analyze-feature"; repo: RepoRef; feature: string }
  | { type: "generate-skill-blueprint"; repo: RepoRef; feature: string; mode: BlueprintMode }
  | { type: "explain-file"; repo: RepoRef }
  | { type: "generate-suggestions"; repo: RepoRef; kind: SuggestionAnalysisKind; label?: string; summary: string; sources: string[] }
  | { type: "answer-question"; repo: RepoRef; question: string; context?: string; contextBasis?: AnalysisBasis };

export type RuntimeResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export type PortMessage =
  | { id: string; request: RuntimeRequest }
  | { id: string; response: RuntimeResponse<unknown> }
  | { id: string; event: "heartbeat" | "stream-start" | "stream-delta" | "stream-done" | "stream-error" | "stream-fallback"; text?: string; error?: string };
