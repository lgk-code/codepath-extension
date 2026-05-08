import { unzipSync, strFromU8 } from "fflate";
import type { TreeFile } from "../types";

type ZipEntry = {
  path: string;
  content: Uint8Array;
};

export class ZipGithubClient {
  private entries: ZipEntry[] | null = null;
  private resolvedBranch = "main";

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly requestedBranch?: string
  ) {}

  async getRepo(): Promise<{ default_branch: string }> {
    await this.ensureEntries();
    return { default_branch: this.resolvedBranch };
  }

  async getTree(): Promise<TreeFile[]> {
    const entries = await this.ensureEntries();
    return entries.map((entry) => ({
      path: entry.path,
      type: "blob",
      size: entry.content.byteLength
    }));
  }

  async getFile(path: string): Promise<string> {
    const entries = await this.ensureEntries();
    const entry = entries.find((item) => item.path === path);
    if (!entry) throw new Error(`File not found in zip: ${path}`);
    return strFromU8(entry.content);
  }

  private async ensureEntries(): Promise<ZipEntry[]> {
    if (this.entries) return this.entries;

    const branches = unique([this.requestedBranch, "main", "master"].filter(Boolean) as string[]);
    let lastError = "";

    for (const branch of branches) {
      try {
        const response = await fetch(`https://codeload.github.com/${this.owner}/${this.repo}/zip/refs/heads/${encodeURIComponent(branch)}`);
        if (!response.ok) {
          lastError = `${response.status} ${response.statusText}`;
          continue;
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        const zip = unzipSync(buffer);
        const entries = Object.entries(zip)
          .filter(([path]) => !path.endsWith("/"))
          .map(([path, content]) => ({
            path: stripRoot(path),
            content
          }))
          .filter((entry) => entry.path.length > 0);
        this.entries = entries;
        this.resolvedBranch = branch;
        return entries;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new Error(`无法下载公开仓库 zip，最后一次错误：${lastError}`);
  }
}

function stripRoot(path: string): string {
  const index = path.indexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
