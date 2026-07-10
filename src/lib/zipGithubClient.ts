import { unzipSync, strFromU8 } from "fflate";
import type { RepoSnapshot, SourceClient, TreeFile } from "../types";
import { discardResponse, fetchWithTimeout, readResponseBytesLimited } from "./fetchUtils";
import { isUsefulPath } from "./fileRules";
import { digestZipEntries } from "./sourceIdentity";

type ZipEntry = {
  path: string;
  content: Uint8Array;
};

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 80 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_ENTRY_BYTES = 2 * 1024 * 1024;

export class ZipGithubClient implements SourceClient {
  readonly kind = "github-zip" as const;

  private entries: ZipEntry[] | null = null;
  private resolvedBranch: string;
  private snapshotIdentity = "";

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly requestedBranch?: string
  ) {
    this.resolvedBranch = requestedBranch || "HEAD";
  }

  async getRepo(): Promise<{ default_branch: string }> {
    await this.ensureEntries();
    return { default_branch: this.resolvedBranch };
  }

  async getBranchSnapshot(owner: string, repo: string, branch: string): Promise<RepoSnapshot> {
    await this.ensureEntries();
    const capturedAt = new Date().toISOString();
    const refName = this.resolvedBranch || branch;
    const identity = this.snapshotIdentity || `${refName}:unknown`;
    return {
      owner,
      repo,
      refName,
      headSha: `unchecked:${identity}`,
      treeSha: `unchecked:${identity}`,
      capturedAt,
      lastValidatedAt: capturedAt
    };
  }

  async getTree(_owner = this.owner, _repo = this.repo, _branch = this.resolvedBranch): Promise<TreeFile[]> {
    const entries = await this.ensureEntries();
    return entries.map((entry) => ({
      path: entry.path,
      type: "blob",
      size: entry.content.byteLength
    }));
  }

  async getFile(_owner: string, _repo: string, path: string, _ref: string): Promise<string> {
    const entries = await this.ensureEntries();
    const entry = entries.find((item) => item.path === path);
    if (!entry) throw new Error(`File not found in zip: ${path}`);
    return strFromU8(entry.content);
  }

  private async ensureEntries(): Promise<ZipEntry[]> {
    if (this.entries) return this.entries;

    const branches = this.requestedBranch ? [this.requestedBranch] : ["HEAD"];
    let lastError = "";

    for (const branch of branches) {
      try {
        const archiveUrl =
          branch === "HEAD"
            ? `https://codeload.github.com/${this.owner}/${this.repo}/zip/HEAD`
            : `https://codeload.github.com/${this.owner}/${this.repo}/zip/refs/heads/${encodeURIComponent(branch)}`;
        const response = await fetchWithTimeout(archiveUrl, {}, 45_000);
        if (!response.ok) {
          lastError = `${response.status} ${response.statusText}`;
          await discardResponse(response);
          continue;
        }
        const contentLength = Number(response.headers.get("content-length") ?? "0");
        if (contentLength > MAX_ZIP_BYTES) {
          lastError = `zip is too large (${contentLength} bytes)`;
          await discardResponse(response);
          continue;
        }

        const buffer = await readResponseBytesLimited(response, MAX_ZIP_BYTES);
        const selectedPaths = new Set<string>();
        let rawEntryCount = 0;
        let selectedBytes = 0;
        let limitError = "";
        const zip = unzipSync(buffer, {
          filter(file) {
            rawEntryCount += 1;
            if (rawEntryCount > MAX_ZIP_ENTRIES) {
              limitError = `zip has too many entries (${rawEntryCount})`;
              return false;
            }
            if (file.name.endsWith("/")) return false;
            const path = stripRoot(file.name);
            if (!path || !isUsefulPath(path)) return false;
            if (file.originalSize > MAX_ZIP_ENTRY_BYTES) {
              limitError = `zip entry is too large (${path}, ${file.originalSize} bytes)`;
              return false;
            }
            if (selectedBytes + file.originalSize > MAX_UNZIPPED_BYTES) {
              limitError = `zip content is too large (${selectedBytes + file.originalSize} bytes)`;
              return false;
            }
            selectedBytes += file.originalSize;
            selectedPaths.add(file.name);
            return true;
          }
        });
        if (limitError) {
          lastError = limitError;
          continue;
        }
        const entries = Object.entries(zip)
          .filter(([path]) => selectedPaths.has(path))
          .filter(([path]) => !path.endsWith("/"))
          .map(([path, content]) => ({
            path: stripRoot(path),
            content
          }))
          .filter((entry) => entry.path.length > 0);

        this.entries = entries;
        this.resolvedBranch = branch;
        this.snapshotIdentity = `${branch}:${await digestZipEntries(entries)}`;
        return entries;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new Error(`Unable to download public repository zip. Last error: ${lastError}`);
  }
}

function stripRoot(path: string): string {
  const index = path.indexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}
