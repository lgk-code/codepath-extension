export type Provider = "qwen" | "custom";

export type Settings = {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  githubToken?: string;
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
};

export type ProjectOverview = {
  summary: string;
  sources: SourceRef[];
};

export type FeaturePath = {
  feature: string;
  summary: string;
  sources: SourceRef[];
};

export type BlueprintMode = "human" | "openclaw-skill" | "new-project";

export type SkillBlueprint = {
  feature: string;
  mode: BlueprintMode;
  summary: string;
  sources: SourceRef[];
};

export type FileExplanation = {
  path: string;
  summary: string;
  sources: SourceRef[];
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
};

export type RuntimeRequest =
  | { type: "get-settings" }
  | { type: "save-settings"; settings: Settings }
  | { type: "test-settings"; repo?: RepoRef }
  | { type: "analyze-project"; repo: RepoRef }
  | { type: "analyze-feature"; repo: RepoRef; feature: string }
  | { type: "explain-file"; repo: RepoRef }
  | { type: "answer-question"; repo: RepoRef; question: string; context?: string };

export type RuntimeResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export type PortMessage =
  | { id: string; request: RuntimeRequest }
  | { id: string; response: RuntimeResponse<unknown> };
