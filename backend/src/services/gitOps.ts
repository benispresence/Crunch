/**
 * Thin wrapper around the local `git` binary for the workspace
 * directory. Used by the /api/git routes to back the user's
 * collections with a real git history.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  cwd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    const child = spawn("git", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export interface RepoStatus {
  initialized: boolean;
  branch: string | null;
  remote_url: string | null;
  ahead: number;
  behind: number;
  has_uncommitted: boolean;
  uncommitted_files: string[];
  last_commit: { sha: string; subject: string; author: string; date: string } | null;
}

export async function ensureWorkspaceDir(workspaceDir: string): Promise<void> {
  await fs.mkdir(workspaceDir, { recursive: true });
}

export async function isInitialized(workspaceDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(workspaceDir, ".git"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function init(workspaceDir: string): Promise<RunResult> {
  await ensureWorkspaceDir(workspaceDir);
  const r = await run(workspaceDir, ["init", "-b", "main"]);
  if (!r.ok) return r;
  // Sensible defaults for a fresh nicemeta workspace.
  await run(workspaceDir, ["config", "user.email", "nicemeta@local"]);
  await run(workspaceDir, ["config", "user.name", "NiceMeta"]);
  return r;
}

export async function status(workspaceDir: string): Promise<RepoStatus> {
  const initialized = await isInitialized(workspaceDir);
  if (!initialized) {
    return {
      initialized: false,
      branch: null,
      remote_url: null,
      ahead: 0,
      behind: 0,
      has_uncommitted: false,
      uncommitted_files: [],
      last_commit: null,
    };
  }
  const branchR = await run(workspaceDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchR.ok ? branchR.stdout.trim() : null;

  const remoteR = await run(workspaceDir, ["remote", "get-url", "origin"]);
  const remoteUrl = remoteR.ok ? remoteR.stdout.trim() : null;

  // ahead/behind only meaningful when an upstream exists
  let ahead = 0;
  let behind = 0;
  const upstreamR = await run(workspaceDir, [
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...@{u}",
  ]);
  if (upstreamR.ok) {
    const parts = upstreamR.stdout.trim().split(/\s+/);
    ahead = Number(parts[0] ?? 0);
    behind = Number(parts[1] ?? 0);
  }

  const dirtyR = await run(workspaceDir, ["status", "--porcelain"]);
  const dirty = dirtyR.ok ? dirtyR.stdout.trim() : "";
  const uncommitted = dirty
    ? dirty.split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
    : [];

  const logR = await run(workspaceDir, ["log", "-1", "--pretty=format:%H%x09%s%x09%an%x09%aI"]);
  let lastCommit: RepoStatus["last_commit"] = null;
  if (logR.ok && logR.stdout.trim()) {
    const [sha = "", subject = "", author = "", date = ""] = logR.stdout.trim().split("\t");
    lastCommit = { sha, subject, author, date };
  }
  return {
    initialized: true,
    branch,
    remote_url: remoteUrl,
    ahead,
    behind,
    has_uncommitted: uncommitted.length > 0,
    uncommitted_files: uncommitted,
    last_commit: lastCommit,
  };
}

export async function commitAll(
  workspaceDir: string,
  message: string,
): Promise<{ committed: boolean; sha: string | null; stderr: string }> {
  await run(workspaceDir, ["add", "-A"]);
  const dirtyR = await run(workspaceDir, ["status", "--porcelain"]);
  if (dirtyR.ok && dirtyR.stdout.trim() === "") {
    return { committed: false, sha: null, stderr: "nothing to commit" };
  }
  const commitR = await run(workspaceDir, ["commit", "-m", message]);
  if (!commitR.ok) {
    return { committed: false, sha: null, stderr: commitR.stderr || commitR.stdout };
  }
  const sha = (await run(workspaceDir, ["rev-parse", "HEAD"])).stdout.trim();
  return { committed: true, sha, stderr: "" };
}

export async function push(workspaceDir: string): Promise<RunResult> {
  // Use --set-upstream so first push wires the remote tracking ref.
  const branchR = await run(workspaceDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchR.ok ? branchR.stdout.trim() : "main";
  return await run(workspaceDir, ["push", "-u", "origin", branch], { timeoutMs: 120_000 });
}

export async function pull(workspaceDir: string): Promise<RunResult> {
  return await run(workspaceDir, ["pull", "--ff-only"], { timeoutMs: 120_000 });
}

export async function setRemote(workspaceDir: string, url: string): Promise<RunResult> {
  const exists = await run(workspaceDir, ["remote"]);
  if (exists.ok && exists.stdout.split(/\s+/).includes("origin")) {
    return await run(workspaceDir, ["remote", "set-url", "origin", url]);
  }
  return await run(workspaceDir, ["remote", "add", "origin", url]);
}

export async function clone(targetDir: string, url: string): Promise<RunResult> {
  // Clone into a temp dir then move contents — needed because better-sqlite3
  // and our backend are running with the workspace path already known.
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(targetDir);
  if (entries.some((e) => e !== ".git" && !e.startsWith("."))) {
    return {
      ok: false,
      code: -1,
      stdout: "",
      stderr: `target ${targetDir} is not empty`,
    };
  }
  // git clone needs an empty target; clone into a sibling temp then move.
  const tmp = `${targetDir}.cloning-${Date.now()}`;
  const cloneR = await run(path.dirname(tmp), ["clone", url, path.basename(tmp)], {
    timeoutMs: 180_000,
  });
  if (!cloneR.ok) {
    await fs.rm(tmp, { recursive: true, force: true });
    return cloneR;
  }
  // Move .git and content over.
  for (const name of await fs.readdir(tmp)) {
    await fs.rename(path.join(tmp, name), path.join(targetDir, name));
  }
  await fs.rm(tmp, { recursive: true, force: true });
  return cloneR;
}

export async function recentLog(
  workspaceDir: string,
  limit = 20,
): Promise<Array<{ sha: string; subject: string; author: string; date: string }>> {
  const r = await run(workspaceDir, [
    "log",
    `-n${limit}`,
    "--pretty=format:%H%x09%s%x09%an%x09%aI",
  ]);
  if (!r.ok || !r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [sha = "", subject = "", author = "", date = ""] = line.split("\t");
      return { sha, subject, author, date };
    });
}
