/**
 * Killable child-process execution for pipeline runs.
 *
 * User code runs in `python -m crunch.pipelines.runner`, not in the
 * Node event loop and not in the FastAPI worker thread. Cancel sends
 * SIGTERM to the process group, then SIGKILL.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PipelineJob {
  code: string;
  destination: Record<string, unknown>;
  source_config?: Record<string, unknown>;
  source_connection?: Record<string, unknown> | null;
  stream_max_seconds?: number;
  stream_max_messages?: number;
  timeout_seconds?: number;
}

export interface PipelineJobResult {
  success: boolean;
  rows_loaded: number;
  log: string;
  error: string | null;
  duration_ms: number;
  steps: unknown[];
  output_tables: unknown[];
  checkpoints: unknown[];
  rows?: Record<string, unknown>[];
}

export interface SpawnedPipeline {
  pid: number;
  child: ChildProcess;
  jobPath: string;
  jobDir: string;
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolvePython(): string {
  const env = process.env.CRUNCH_PYTHON || process.env.PYTHON;
  if (env) return env;
  const candidates = [
    path.resolve(process.cwd(), "..", "venv", "bin", "python"),
    path.resolve(process.cwd(), "venv", "bin", "python"),
    path.resolve(process.cwd(), "..", "venv", "bin", "python3"),
    path.resolve(process.cwd(), "venv", "bin", "python3"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "python3";
}

export function repoRoot(): string {
  const fromCwd = path.resolve(process.cwd(), "..");
  if (fs.existsSync(path.join(fromCwd, "src", "crunch"))) return fromCwd;
  if (fs.existsSync(path.join(process.cwd(), "src", "crunch"))) return process.cwd();
  return fromCwd;
}

export function spawnPipelineProcess(job: PipelineJob): SpawnedPipeline {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "crunch-pipe-"));
  const jobPath = path.join(jobDir, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify(job), { mode: 0o600 });
  const python = resolvePython();
  const root = repoRoot();
  const src = path.join(root, "src");
  const child = spawn(python, ["-m", "crunch.pipelines.runner", jobPath], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: src + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : "") },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid == null) {
    throw new Error("failed to spawn pipeline process");
  }
  return { pid: child.pid, child, jobPath, jobDir };
}

/** SIGTERM the process group, then SIGKILL after `graceMs`. */
export function killSpawned(spawned: SpawnedPipeline, graceMs = 2000): void {
  killPid(spawned.pid, graceMs);
}

export function killPid(pid: number, graceMs = 2000): void {
  if (!pid || pid <= 0) return;
  const term = () => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };
  const kill = () => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  term();
  if (graceMs <= 0) {
    kill();
    return;
  }
  setTimeout(() => {
    if (isPidAlive(pid)) kill();
  }, graceMs).unref();
}

export function readJobResult(jobPath: string): PipelineJobResult | null {
  const resultPath = jobPath + ".result.json";
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, "utf8")) as PipelineJobResult;
  } catch {
    return null;
  }
}

export function cleanupJobDir(jobDir: string | null | undefined): void {
  if (!jobDir) return;
  try {
    fs.rmSync(jobDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
}
