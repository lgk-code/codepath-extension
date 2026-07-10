import type { RepoRef, RepoSnapshot, SourceClient, TreeFile, Settings } from "../types";
import { discardResponse, fetchWithTimeout, readJsonResponse, safeResponseText } from "./fetchUtils";
import { isValidGithubRepositoryIdentity } from "./githubUrl";

type GithubRepo = {
  default_branch: string;
  description?: string;
  language?: string;
};

type GithubBranchResponse = {
  commit?: {
    sha?: string;
    commit?: {
      tree?: {
        sha?: string;
      };
    };
  };
};

type GithubCommitResponse = {
  sha?: string;
  commit?: {
    tree?: {
      sha?: string;
    };
  };
  tree?: {
    sha?: string;
  };
};

type GithubTagResponse = {
  object?: {
    sha?: string;
    type?: string;
  };
};

type GithubRefResponse = {
  ref?: string;
  object?: {
    sha?: string;
    type?: string;
  };
};

type GithubTreeResponse = {
  truncated?: boolean;
  tree: Array<{
    path: string;
    type: "blob" | "tree";
    sha: string;
    size?: number;
  }>;
};

type GithubContentResponse = {
  type?: string;
  content?: string;
  encoding?: string;
};

const MAX_EXISTING_REF_CANDIDATES = 8;
const MAX_MATCHING_REFS_PER_NAMESPACE = 100;
const MAX_REF_METADATA_BYTES = 512 * 1024;

export class GithubClient implements SourceClient {
  readonly kind = "github-api" as const;
  private readonly repoRequests = new Map<string, Promise<GithubRepo>>();
  private readonly treeRequests = new Map<string, Promise<TreeFile[]>>();
  private readonly snapshotRequests = new Map<string, Promise<RepoSnapshot>>();

  constructor(private readonly settings: Pick<Settings, "githubToken">) {}

  async getRepo(owner: string, repo: string): Promise<GithubRepo> {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    return this.memoize(this.repoRequests, key, () => this.request<GithubRepo>(repoApiBase(owner, repo)));
  }

  async getTree(owner: string, repo: string, branch: string): Promise<TreeFile[]> {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}@${branch}`;
    return this.memoize(this.treeRequests, key, async () => {
      const data = await this.request<GithubTreeResponse>(
        `${repoApiBase(owner, repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        8 * 1024 * 1024
      );
      if (data.truncated) {
        throw new Error("GitHub API returned a truncated repository tree. 请缩小分析范围或稍后使用分层遍历版本。");
      }
      return data.tree.map((item) => ({
        path: item.path,
        type: item.type,
        sha: item.sha,
        size: item.size
      }));
    });
  }

  async getBranchSnapshot(owner: string, repo: string, branch: string): Promise<RepoSnapshot> {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}@${branch}`;
    return this.memoize(this.snapshotRequests, key, () => this.loadBranchSnapshot(owner, repo, branch));
  }

  async resolveRepoRef(repo: RepoRef): Promise<RepoRef> {
    const candidates = uniqueCandidates(repo.refCandidates ?? []);
    if (candidates.length <= 1) return repo;

    const existingCandidates = await this.findExistingRefCandidates(repo.owner, repo.repo, repo.branch, candidates);
    if (existingCandidates.length > MAX_EXISTING_REF_CANDIDATES) {
      throw new Error("Ambiguous GitHub ref/path has too many existing ref boundaries to validate safely.");
    }

    const viable: Array<{ refName: string; path: string }> = [];
    for (const candidate of existingCandidates) {
      try {
        const contentPath = candidate.path ? `/contents/${encodePath(candidate.path)}` : "/contents";
        const metadata = await this.requestOptional<GithubContentResponse | unknown[]>(
          `${repoApiBase(repo.owner, repo.repo)}${contentPath}?ref=${encodeURIComponent(candidate.refName)}`,
          MAX_REF_METADATA_BYTES
        );
        const matchesFile = repo.pageType === "file" && !Array.isArray(metadata) && ["file", "symlink", "submodule"].includes(metadata?.type ?? "");
        const matchesDirectory = repo.pageType === "directory" && Array.isArray(metadata);
        if (matchesFile || matchesDirectory) {
          viable.push(candidate);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("did not include a head commit SHA")) continue;
        throw new Error(`Ambiguous GitHub ref/path could not be validated safely: ${message}`);
      }
    }

    if (viable.length !== 1) {
      const reason = viable.length === 0 ? "no candidate matched a GitHub ref and path" : "multiple candidates matched GitHub refs and paths";
      throw new Error(`Ambiguous GitHub ref/path: ${reason}. Open an immutable commit URL or analyze the repository root.`);
    }
    return { ...repo, branch: viable[0]!.refName, path: viable[0]!.path, refCandidates: viable };
  }

  private async findExistingRefCandidates(
    owner: string,
    repo: string,
    selectedRef: string | undefined,
    candidates: Array<{ refName: string; path: string }>
  ): Promise<Array<{ refName: string; path: string }>> {
    if (selectedRef && /^[0-9a-f]{40}$/i.test(selectedRef)) {
      const commit = await this.getRepoCommit(owner, repo, selectedRef);
      return commit?.sha ? candidates.filter((candidate) => candidate.refName === selectedRef) : [];
    }

    const prefix = candidates[0]?.refName.split("/")[0] ?? "";
    if (!prefix || prefix === "." || prefix === ".." || prefix.includes("\\")) {
      throw new Error("Ambiguous GitHub ref/path contains an unsafe ref prefix.");
    }
    const [heads, tags, abbreviatedCommit] = await Promise.all([
      this.requestOptional<GithubRefResponse[]>(
        `${repoApiBase(owner, repo)}/git/matching-refs/${encodePath(`heads/${prefix}`)}?per_page=${MAX_MATCHING_REFS_PER_NAMESPACE}`,
        MAX_REF_METADATA_BYTES
      ),
      this.requestOptional<GithubRefResponse[]>(
        `${repoApiBase(owner, repo)}/git/matching-refs/${encodePath(`tags/${prefix}`)}?per_page=${MAX_MATCHING_REFS_PER_NAMESPACE}`,
        MAX_REF_METADATA_BYTES
      ),
      selectedRef && /^[0-9a-f]{7,39}$/i.test(selectedRef) ? this.getRepoCommit(owner, repo, selectedRef) : Promise.resolve(undefined)
    ]);
    if ((heads?.length ?? 0) >= MAX_MATCHING_REFS_PER_NAMESPACE || (tags?.length ?? 0) >= MAX_MATCHING_REFS_PER_NAMESPACE) {
      throw new Error("Ambiguous GitHub ref/path matched too many repository refs to validate safely.");
    }

    const existingNames = new Set<string>();
    for (const item of heads ?? []) {
      if (item.ref?.startsWith("refs/heads/")) existingNames.add(item.ref.slice("refs/heads/".length));
    }
    for (const item of tags ?? []) {
      if (item.ref?.startsWith("refs/tags/")) existingNames.add(item.ref.slice("refs/tags/".length));
    }
    if (selectedRef && abbreviatedCommit?.sha) existingNames.add(selectedRef);
    return candidates.filter((candidate) => existingNames.has(candidate.refName));
  }

  private async loadBranchSnapshot(owner: string, repo: string, branch: string): Promise<RepoSnapshot> {
    const capturedAt = new Date().toISOString();
    const branchData = branch.includes("/")
      ? undefined
      : await this.requestOptional<GithubBranchResponse>(`${repoApiBase(owner, repo)}/branches/${encodeURIComponent(branch)}`);
    const branchHeadSha = branchData ? "" : await this.getBranchHeadSha(owner, repo, branch);
    const commitData = branchData || branchHeadSha ? undefined : await this.getRepoCommit(owner, repo, branch);
    const tagCommitSha = branchData || commitData || branchHeadSha ? "" : await this.getTagCommitSha(owner, repo, branch);
    const headSha = branchData?.commit?.sha?.trim() || commitData?.sha?.trim() || branchHeadSha || tagCommitSha;
    if (!headSha) throw new Error(`GitHub branch ${branch} did not include a head commit SHA.`);
    const treeSha = branchData?.commit?.commit?.tree?.sha?.trim() || commitData?.commit?.tree?.sha?.trim() || commitData?.tree?.sha?.trim() || (await this.getCommitTreeSha(owner, repo, headSha));
    if (!treeSha) throw new Error(`GitHub branch ${branch} did not include a root tree SHA.`);
    return {
      owner,
      repo,
      refName: branch,
      headSha,
      treeSha,
      capturedAt,
      lastValidatedAt: capturedAt
    };
  }

  async getFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const url = `${repoApiBase(owner, repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
    const data = await this.request<GithubContentResponse>(url);
    if (!data.content) return "";
    if (data.encoding !== "base64") return data.content;
    return decodeBase64(data.content);
  }

  private async request<T>(url: string, jsonLimit?: number): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (this.settings.githubToken) headers.Authorization = `Bearer ${this.settings.githubToken}`;

    let response: Response;
    try {
      response = await fetchWithTimeout(url, { headers }, 30_000);
    } catch (error) {
      throw new Error(`Unable to reach GitHub API: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await safeResponseText(response)}`);
    }
    return readJsonResponse<T>(response, jsonLimit);
  }

  private async requestOptional<T>(url: string, jsonLimit?: number): Promise<T | undefined> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (this.settings.githubToken) headers.Authorization = `Bearer ${this.settings.githubToken}`;

    const response = await fetchWithTimeout(url, { headers }, 30_000);
    if (response.status === 404) {
      await discardResponse(response);
      return undefined;
    }
    if (!response.ok) {
      const body = await safeResponseText(response);
      throw new Error(`GitHub request failed ${response.status}: ${body || response.statusText}`);
    }
    return readJsonResponse<T>(response, jsonLimit);
  }

  private async getRepoCommit(owner: string, repo: string, ref: string): Promise<GithubCommitResponse | undefined> {
    return this.requestOptional<GithubCommitResponse>(`${repoApiBase(owner, repo)}/commits/${encodeURIComponent(ref)}`);
  }

  private async getCommitTreeSha(owner: string, repo: string, sha: string): Promise<string> {
    const data = await this.request<GithubCommitResponse>(`${repoApiBase(owner, repo)}/git/commits/${encodeURIComponent(sha)}`);
    return data.tree?.sha?.trim() ?? "";
  }

  private async getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string | undefined> {
    const data = await this.requestOptional<GithubRefResponse>(`${repoApiBase(owner, repo)}/git/ref/${encodePath(`heads/${branch}`)}`);
    if (!data) return undefined;
    if (data.object?.type && data.object.type !== "commit") {
      throw new Error(`GitHub ref heads/${branch} points to ${data.object.type}, not a commit.`);
    }
    return data.object?.sha?.trim() ?? "";
  }

  private async getTagCommitSha(owner: string, repo: string, tag: string): Promise<string> {
    const data = await this.requestOptional<GithubRefResponse>(`${repoApiBase(owner, repo)}/git/ref/${encodePath(`tags/${tag}`)}`);
    const object = data?.object;
    if (!object?.sha) return "";
    if (!object.type || object.type === "commit") return object.sha.trim();
    if (object.type !== "tag") throw new Error(`GitHub ref tags/${tag} points to ${object.type}, not a commit or tag.`);

    const annotated = await this.requestOptional<GithubTagResponse>(`${repoApiBase(owner, repo)}/git/tags/${encodeURIComponent(object.sha)}`);
    if (annotated?.object?.type && annotated.object.type !== "commit") {
      throw new Error(`GitHub tag ${tag} points to ${annotated.object.type}, not a commit.`);
    }
    return annotated?.object?.sha?.trim() ?? "";
  }

  private async memoize<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = load();
    cache.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }
}

function uniqueCandidates(candidates: Array<{ refName: string; path: string }>): Array<{ refName: string; path: string }> {
  return Array.from(new Map(candidates.map((candidate) => [`${candidate.refName}\0${candidate.path}`, candidate])).values());
}

function repoApiBase(owner: string, repo: string): string {
  if (!isValidGithubRepositoryIdentity(owner, repo)) throw new Error(`Invalid GitHub repository identity: ${owner}/${repo}`);
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function encodePath(path: string): string {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error(`Unsafe GitHub path: ${path}`);
  }
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

function decodeBase64(value: string): string {
  const binary = atob(value.replaceAll("\n", ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
