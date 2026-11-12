// The first executor: open a draft PR (docs/APPROVALS.md, "First executor").
// It runs only after a device-signed approve, with exactly the inputs the
// signature's inputs_hash binds.
//
// Rules, each enforced here rather than trusted to the proposer:
// - head_branch starts with agent/ and is a plain branch name;
// - the only ref written is refs/heads/<head_branch>, created, never updated,
//   and never the repository's default branch or base;
// - the repository is on the pr_repo_allowlist setting, checked when the
//   proposal is filed and again before anything is written;
// - no file under .github/, because a pushed workflow would run with the
//   repository's secrets before anyone reviews the PR.

import type { Env } from "./check";
import { fail, HttpError } from "./http";

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Free-plan Workers make at most 50 subrequests per invocation. Opening a PR
// costs 7 GitHub calls plus one blob per file, and the decision itself about
// 5 D1 calls, so 30 files leaves room.
export const MAX_PR_FILES = 30;
const ALLOWLIST_KEY = "pr_repo_allowlist";

export interface PrSpec {
  repo: string;
  base: string;
  head_branch: string;
  title: string;
  body: string;
  files?: { path: string; content_b64: string }[];
  head_sha?: string;
}

// git check-ref-format's rules, narrowed to the characters agents use.
function branchProblem(name: string): string | null {
  if (name.length > 200) return "is longer than 200 characters";
  if (!/^[A-Za-z0-9._\/-]+$/.test(name)) return "may use only letters, digits, . _ / and -";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return "has an empty path segment";
  if (name.endsWith(".") || name.includes("..")) return 'may not end with "." or contain ".."';
  if (name.split("/").some((seg) => seg.startsWith(".") || seg.endsWith(".lock"))) return 'has a segment starting with "." or ending in ".lock"';
  return null;
}

function pathProblem(path: string): string | null {
  if (path.length === 0 || path.length > 400) return "must be 1 to 400 characters";
  if (/[\x00-\x1f\x7f\\]/.test(path)) return "may not contain control characters or backslashes";
  const segs = path.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "must be a relative path without empty, . or .. segments";
  if (segs.some((s) => s.toLowerCase() === ".git")) return "may not touch .git";
  if (segs[0].toLowerCase() === ".github") return "may not be under .github/: a pushed workflow would run with the repository's secrets";
  return null;
}

// Validates a proposal's inputs for final_step_kind open_pr. Errors name the
// field under inputs.
export function validatePrSpec(v: unknown): PrSpec {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("inputs must be an object for final_step_kind open_pr");
  const o = v as Record<string, unknown>;
  const allowed = ["repo", "base", "head_branch", "title", "body", "files", "head_sha"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`inputs.${k} is not an open_pr field (allowed: ${allowed.join(", ")})`);
  if (typeof o.repo !== "string" || !REPO.test(o.repo)) fail("inputs.repo must be owner/name");
  for (const f of ["base", "head_branch"] as const) {
    if (typeof o[f] !== "string") fail(`inputs.${f} must be a branch name`);
    const p = branchProblem(o[f] as string);
    if (p) fail(`inputs.${f} ${p}`);
  }
  const head = o.head_branch as string;
  if (!head.startsWith("agent/") || head.length === "agent/".length) fail("inputs.head_branch must start with agent/");
  if (head === o.base) fail("inputs.head_branch must differ from inputs.base");
  if (typeof o.title !== "string" || o.title.trim() === "" || o.title.length > 256) fail("inputs.title must be a non-empty string of at most 256 characters");
  if (typeof o.body !== "string" || o.body.length > 60_000) fail("inputs.body must be a string of at most 60000 characters");
  const hasFiles = o.files !== undefined;
  const hasSha = o.head_sha !== undefined;
  if (hasFiles === hasSha) fail("inputs needs exactly one of files (the Worker creates the branch) or head_sha (a branch an agent already pushed, pinned to that commit)");
  if (hasSha) {
    if (typeof o.head_sha !== "string" || !SHA.test(o.head_sha)) fail("inputs.head_sha must be a 40-hex commit sha in lowercase");
    return { repo: o.repo, base: o.base as string, head_branch: head, title: o.title, body: o.body, head_sha: o.head_sha };
  }
  if (!Array.isArray(o.files) || o.files.length === 0 || o.files.length > MAX_PR_FILES) fail(`inputs.files must be an array of 1 to ${MAX_PR_FILES} files`);
  const seen = new Set<string>();
  const files = o.files.map((f, i) => {
    const at = `inputs.files[${i}]`;
    if (typeof f !== "object" || f === null || Array.isArray(f)) fail(`${at} must be an object`);
    const x = f as Record<string, unknown>;
    for (const k of Object.keys(x)) if (k !== "path" && k !== "content_b64") fail(`${at}.${k} is not a file field (allowed: path, content_b64)`);
    if (typeof x.path !== "string") fail(`${at}.path must be a string`);
    const p = pathProblem(x.path);
    if (p) fail(`${at}.path ${p}`);
    if (seen.has(x.path)) fail(`${at}.path repeats ${x.path}`);
    seen.add(x.path);
    if (typeof x.content_b64 !== "string" || x.content_b64.length % 4 !== 0 || !B64.test(x.content_b64)) fail(`${at}.content_b64 must be standard base64 with padding`);
    return { path: x.path, content_b64: x.content_b64 };
  });
  return { repo: o.repo, base: o.base as string, head_branch: head, title: o.title, body: o.body, files };
}

export async function repoAllowlist(env: Env): Promise<string[]> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(ALLOWLIST_KEY).first<{ value: string }>();
  if (!row) return [];
  const list = JSON.parse(row.value) as string[];
  return list;
}

const allowed = (list: string[], repo: string) => list.some((r) => r.toLowerCase() === repo.toLowerCase());

export async function assertRepoAllowed(env: Env, repo: string) {
  if (!allowed(await repoAllowlist(env), repo)) throw new HttpError(403, `inputs.repo ${repo} is not on the pr_repo_allowlist setting`);
}

export async function setRepoAllowlist(env: Env, b: Record<string, unknown>) {
  if (!Array.isArray(b.repos) || b.repos.length > 50 || !b.repos.every((r) => typeof r === "string" && REPO.test(r))) fail("repos must be an array of at most 50 owner/name strings");
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
  )
    .bind(ALLOWLIST_KEY, JSON.stringify(b.repos), Date.now())
    .run();
  return { repos: b.repos };
}

// wrote: whether a visible change to the repository may have happened (the
// branch ref was created, or a request that creates one got no answer).
export class ExecError extends Error {
  constructor(
    readonly wrote: boolean,
    message: string,
  ) {
    super(message);
  }
}

const seg = (s: string) => s.split("/").map(encodeURIComponent).join("/");

export async function openPr(env: Env, spec: PrSpec): Promise<string> {
  if (!env.GITHUB_PR_TOKEN) throw new ExecError(false, "GITHUB_PR_TOKEN is not set");
  if (!allowed(await repoAllowlist(env), spec.repo)) throw new ExecError(false, `${spec.repo} is not on the pr_repo_allowlist setting`);
  const origin = env.GITHUB_API_ORIGIN ?? "https://api.github.com";
  const repoPath = `/repos/${seg(spec.repo)}`;
  let wrote = false;
  const gh = async (method: string, path: string, body?: unknown, write = false): Promise<{ status: number; data: Record<string, unknown> }> => {
    let res: Response;
    try {
      res = await fetch(origin + repoPath + path, {
        method,
        headers: {
          authorization: `Bearer ${env.GITHUB_PR_TOKEN}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "discovery-watcher",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      // No answer to a write: it may have happened.
      if (write) wrote = true;
      throw new ExecError(wrote, `GitHub ${method} ${path}: ${e instanceof Error ? e.name : "network error"}`);
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {}
    return { status: res.status, data };
  };
  const need = (r: { status: number; data: Record<string, unknown> }, ok: number, what: string) => {
    if (r.status !== ok) throw new ExecError(wrote, `${what}: GitHub answered ${r.status} ${String(r.data.message ?? "").slice(0, 200)}`);
    return r.data;
  };

  const repo = need(await gh("GET", ""), 200, `read ${spec.repo}`);
  const defaultBranch = String(repo.default_branch ?? "");
  if (!defaultBranch) throw new ExecError(false, `${spec.repo} has no default_branch in GitHub's answer`);
  if (spec.head_branch === defaultBranch || spec.head_branch === spec.base) throw new ExecError(false, `head_branch ${spec.head_branch} is the default branch or base`);

  if (spec.head_sha) {
    const ref = need(await gh("GET", `/git/ref/heads/${seg(spec.head_branch)}`), 200, `read branch ${spec.head_branch}`);
    const at = (ref.object as { sha?: string } | undefined)?.sha;
    if (at !== spec.head_sha) throw new ExecError(false, `branch ${spec.head_branch} is at ${at}, not the approved head_sha ${spec.head_sha}`);
  } else {
    const baseRef = need(await gh("GET", `/git/ref/heads/${seg(spec.base)}`), 200, `read base ${spec.base}`);
    const baseSha = (baseRef.object as { sha?: string } | undefined)?.sha;
    if (!baseSha || !SHA.test(baseSha)) throw new ExecError(false, `base ${spec.base} has no commit sha in GitHub's answer`);
    const baseCommit = need(await gh("GET", `/git/commits/${baseSha}`), 200, "read the base commit");
    const baseTree = (baseCommit.tree as { sha?: string } | undefined)?.sha;
    if (!baseTree) throw new ExecError(false, "the base commit has no tree sha");
    // Blobs, trees and commits nobody references change nothing visible.
    const blobs = await Promise.all(
      spec.files!.map(async (f) => need(await gh("POST", "/git/blobs", { content: f.content_b64, encoding: "base64" }), 201, `write blob ${f.path}`).sha as string),
    );
    const tree = need(
      await gh("POST", "/git/trees", { base_tree: baseTree, tree: spec.files!.map((f, i) => ({ path: f.path, mode: "100644", type: "blob", sha: blobs[i] })) }),
      201,
      "write the tree",
    );
    const commit = need(await gh("POST", "/git/commits", { message: spec.title, tree: tree.sha, parents: [baseSha] }), 201, "write the commit");
    // Creating a ref that exists fails with 422; nothing here updates one.
    const created = await gh("POST", "/git/refs", { ref: `refs/heads/${spec.head_branch}`, sha: commit.sha }, true);
    if (created.status === 201) wrote = true;
    need(created, 201, `create branch ${spec.head_branch}`);
  }
  const pr = need(await gh("POST", "/pulls", { title: spec.title, body: spec.body, head: spec.head_branch, base: spec.base, draft: true }, true), 201, "open the pull request");
  const url = pr.html_url;
  if (typeof url !== "string" || !url.startsWith("https://")) throw new ExecError(true, "GitHub's pull request answer has no html_url");
  return url;
}
