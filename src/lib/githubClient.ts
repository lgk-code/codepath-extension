import type { TreeFile, Settings } from "../types";

type GithubRepo = {
  default_branch: string;
  description?: string;
  language?: string;
};

type GithubTreeResponse = {
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

export class GithubClient {
  constructor(private readonly settings: Pick<Settings, "githubToken">) {}

  async getRepo(owner: string, repo: string): Promise<GithubRepo> {
    return this.request<GithubRepo>(`https://api.github.com/repos/${owner}/${repo}`);
  }

  async getTree(owner: string, repo: string, branch: string): Promise<TreeFile[]> {
    const data = await this.request<GithubTreeResponse>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    return data.tree.map((item) => ({
      path: item.path,
      type: item.type,
      sha: item.sha,
      size: item.size
    }));
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
      response = await fetch(url, { headers });
    } catch (error) {
      throw new Error(`Unable to reach GitHub API: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<T>;
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
