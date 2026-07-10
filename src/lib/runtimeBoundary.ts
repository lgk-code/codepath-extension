import type { RepoRef, RuntimeRequest } from "../types";
import { parseGithubUrl } from "./githubUrl";

export function repoStateKey(repo: RepoRef | null): string {
  if (!repo) return "none";
  return JSON.stringify([repo.owner, repo.repo, repo.branch ?? "", repo.pageType, repo.path ?? ""]);
}

export function validateRepoRequestScope(request: RuntimeRequest, senderUrl: string | undefined): boolean {
  if (!("repo" in request) || !request.repo) return true;
  if (!senderUrl) return false;

  const senderRepo = parseGithubUrl(senderUrl);
  if (!senderRepo) return false;
  return sameName(senderRepo.owner, request.repo.owner) && sameName(senderRepo.repo, request.repo.repo);
}

export function validateRequestLocation(request: RuntimeRequest, currentUrl: string): boolean {
  if (!("repo" in request) || !request.repo) return true;
  const currentRepo = parseGithubUrl(currentUrl);
  if (!currentRepo) return false;
  return (
    sameName(currentRepo.owner, request.repo.owner) &&
    sameName(currentRepo.repo, request.repo.repo) &&
    (currentRepo.branch ?? "") === (request.repo.branch ?? "") &&
    currentRepo.pageType === request.repo.pageType &&
    (currentRepo.path ?? "") === (request.repo.path ?? "")
  );
}

export function canFallbackLocallyBeforeDispatch(request: RuntimeRequest, dispatched: boolean): boolean {
  return !dispatched && request.type === "list-models";
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
