import type { RepoSnapshot, SourceClient, TreeFile, Settings } from "../types";
import { fetchWithTimeout, readJsonResponse, safeResponseText } from "./fetchUtils";

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
  content?: string;
  encoding?: string;
};

export class GithubClient implements SourceClient {
  readonly kind = "github-api" as const;

  constructor(private readonly settings: Pick<Settings, "githubToken">) {}

  async getRepo(owner: string, repo: string): Promise<GithubRepo> {
    return this.request<GithubRepo>(`https://api.github.com/repos/${owner}/${repo}`);
  }

  async getTree(owner: string, repo: string, branch: string): Promise<TreeFile[]> {
    const data = await this.request<GithubTreeResponse>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
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
  }

  async getBranchSnapshot(owner: string, repo: string, branch: string): Promise<RepoSnapshot> {
    const capturedAt = new Date().toISOString();
    const branchData = branch.includes("/")
      ? undefined
      : await this.requestOptional<GithubBranchResponse>(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
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
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
    const data = await this.request<GithubContentResponse>(url);
    if (!data.content) return "";
    if (data.encoding !== "base64") return data.content;
    return decodeBase64(data.content);
  }

  private async request<T>(url: string): Promise<T> {
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
    return readJsonResponse<T>(response);
  }

  private async requestOptional<T>(url: string): Promise<T | undefined> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (this.settings.githubToken) headers.Authorization = `Bearer ${this.settings.githubToken}`;

    const response = await fetchWithTimeout(url, { headers }, 30_000);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const body = await safeResponseText(response);
      throw new Error(`GitHub request failed ${response.status}: ${body || response.statusText}`);
    }
    return readJsonResponse<T>(response);
  }

  private async getRepoCommit(owner: string, repo: string, ref: string): Promise<GithubCommitResponse | undefined> {
    return this.requestOptional<GithubCommitResponse>(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  }

  private async getCommitTreeSha(owner: string, repo: string, sha: string): Promise<string> {
    const data = await this.request<GithubCommitResponse>(`https://api.github.com/repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`);
    return data.tree?.sha?.trim() ?? "";
  }

  private async getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string | undefined> {
    const data = await this.requestOptional<GithubRefResponse>(`https://api.github.com/repos/${owner}/${repo}/git/ref/${encodePath(`heads/${branch}`)}`);
    if (!data) return undefined;
    if (data.object?.type && data.object.type !== "commit") {
      throw new Error(`GitHub ref heads/${branch} points to ${data.object.type}, not a commit.`);
    }
    return data.object?.sha?.trim() ?? "";
  }

  private async getTagCommitSha(owner: string, repo: string, tag: string): Promise<string> {
    const data = await this.requestOptional<GithubRefResponse>(`https://api.github.com/repos/${owner}/${repo}/git/ref/${encodePath(`tags/${tag}`)}`);
    const object = data?.object;
    if (!object?.sha) return "";
    if (!object.type || object.type === "commit") return object.sha.trim();
    if (object.type !== "tag") throw new Error(`GitHub ref tags/${tag} points to ${object.type}, not a commit or tag.`);

    const annotated = await this.requestOptional<GithubTagResponse>(`https://api.github.com/repos/${owner}/${repo}/git/tags/${encodeURIComponent(object.sha)}`);
    if (annotated?.object?.type && annotated.object.type !== "commit") {
      throw new Error(`GitHub tag ${tag} points to ${annotated.object.type}, not a commit.`);
    }
    return annotated?.object?.sha?.trim() ?? "";
  }
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function decodeBase64(value: string): string {
  const binary = atob(value.replaceAll("\n", ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
