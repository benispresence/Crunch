import { db } from "../db/index.js";
import { pythonEngine } from "./pythonEngine.js";

/**
 * Import names the visualization sandbox is allowed to use.
 *
 * Derived from the package table here rather than taken from the request:
 * the sandbox whitelist decides what user Python may import, so letting a
 * client name its own packages would hand it the sandbox. The engine folds in
 * its safe-stdlib set and subtracts its blocklist on top of whatever we send,
 * so this is a narrowing input, never a widening one.
 */
export function allowedImportNames(): string[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(import_name, package_name) AS name
       FROM allowed_packages
       WHERE is_enabled = 1 AND status = 'installed'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((name) => !isVizBlockedImport(name));
}

/**
 * Import name → pip name for every enabled+installed package. The pipeline
 * worker merges this over its built-in defaults (dlt, requests, …).
 */
export function pipelineAllowedPackages(): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT COALESCE(import_name, package_name) AS name, package_name
       FROM allowed_packages
       WHERE is_enabled = 1 AND status = 'installed'`,
    )
    .all() as Array<{ name: string; package_name: string }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.name] = row.package_name;
  return out;
}

/** True when the row is a Python stdlib module — no pip, no version. */
export function isStdlibRow(installedVersion: string | null | undefined): boolean {
  return installedVersion === "stdlib";
}

/**
 * Third-party modules the viz sandbox will never import, even when the
 * package is installed. Keep in sync with
 * ``crunch.visualization.sandbox_modules.VIZ_BLOCKED_PYPI``.
 * Pipelines *can* import these; that's why the package manager installs them.
 */
export const VIZ_BLOCKED_PYPI = new Set(["requests"]);

export function isVizBlockedImport(name: string): boolean {
  return VIZ_BLOCKED_PYPI.has((name.split(".")[0] ?? name).toLowerCase());
}

/** Seeded so REST / dlt / kafka pipelines have a row an admin can install. */
export const PIPELINE_DEFAULT_PACKAGES: Array<{
  package_name: string;
  import_name: string;
}> = [
  { package_name: "requests", import_name: "requests" },
  { package_name: "dlt", import_name: "dlt" },
  { package_name: "httpx", import_name: "httpx" },
  { package_name: "kafka-python", import_name: "kafka" },
];

const PIPELINE_DEFAULT_NAMES = new Set(
  PIPELINE_DEFAULT_PACKAGES.map((p) => p.package_name),
);

export function isPipelineDefault(packageName: string): boolean {
  return PIPELINE_DEFAULT_NAMES.has(packageName);
}

export interface PackageRow {
  id: number;
  package_name: string;
  import_name: string | null;
  version_spec: string | null;
  installed_version: string | null;
  status: string;
  error_message: string | null;
  is_default: number;
  is_enabled: number;
  created_at: number;
  updated_at: number;
}

export function getPackage(id: number): PackageRow | undefined {
  return db
    .prepare("SELECT * FROM allowed_packages WHERE id = ?")
    .get(id) as PackageRow | undefined;
}

export function findPackage(
  packageName: string,
  importName?: string,
): PackageRow | undefined {
  return db
    .prepare(
      "SELECT * FROM allowed_packages WHERE package_name = ? OR import_name = ? OR import_name = ? LIMIT 1",
    )
    .get(packageName, importName ?? packageName, packageName) as
    | PackageRow
    | undefined;
}

/** Insert pending default rows for pipeline libraries. Idempotent. */
export function seedPipelinePackageRows(): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO allowed_packages (package_name, import_name, is_default, is_enabled, status) VALUES (?, ?, 1, 1, 'pending')",
  );
  for (const pkg of PIPELINE_DEFAULT_PACKAGES) {
    insert.run(pkg.package_name, pkg.import_name);
  }
}

export async function installPackageById(
  id: number,
): Promise<{ success: boolean; version?: string; error?: string; viz_blocked?: boolean }> {
  const row = getPackage(id);
  if (!row) return { success: false, error: "not found" };
  db.prepare(
    "UPDATE allowed_packages SET status = 'installing', error_message = NULL, updated_at = strftime('%s', 'now') WHERE id = ?",
  ).run(id);
  try {
    const r = await pythonEngine.installPackage(
      row.package_name,
      row.version_spec ?? undefined,
    );
    db.prepare(
      "UPDATE allowed_packages SET status = ?, installed_version = ?, error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(
      r.success ? "installed" : "failed",
      r.version ?? null,
      r.error ?? null,
      id,
    );
    return r;
  } catch (err) {
    const msg = (err as Error).message;
    db.prepare(
      "UPDATE allowed_packages SET status = 'failed', error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(msg, id);
    return { success: false, error: msg };
  }
}

/**
 * Add a package row (or reuse the existing one) and optionally pip-install
 * it. Used by the admin form and by the pipeline editor's one-click install.
 */
export async function addOrInstallPackage(opts: {
  package_name: string;
  import_name?: string;
  version_spec?: string;
  auto_install?: boolean;
}): Promise<PackageRow> {
  const packageName = opts.package_name.trim();
  const importName = (opts.import_name ?? packageName).trim();
  const existing = findPackage(packageName, importName);
  let id: number;
  if (existing) {
    id = existing.id;
    db.prepare(
      `UPDATE allowed_packages
          SET package_name = ?, import_name = ?,
              version_spec = COALESCE(?, version_spec),
              is_enabled = 1,
              updated_at = strftime('%s', 'now')
        WHERE id = ?`,
    ).run(packageName, importName, opts.version_spec ?? null, id);
  } else {
    const info = db
      .prepare(
        "INSERT INTO allowed_packages (package_name, import_name, version_spec, status, is_enabled) VALUES (?, ?, ?, 'pending', 1)",
      )
      .run(packageName, importName, opts.version_spec ?? null);
    id = Number(info.lastInsertRowid);
  }
  if (opts.auto_install !== false) {
    await installPackageById(id);
  }
  return getPackage(id)!;
}

/**
 * Make sure REST/dlt pipeline defaults exist as rows, and try to pip-install
 * ``requests`` (the generated REST template imports it). Other defaults stay
 * pending so an offline box isn't stuck installing dlt on every boot.
 */
export async function ensurePipelinePackages(): Promise<{
  installed: string[];
  failed: string[];
}> {
  seedPipelinePackageRows();
  const installed: string[] = [];
  const failed: string[] = [];
  const auto = ["requests", "httpx"];
  for (const name of auto) {
    const row = db
      .prepare("SELECT * FROM allowed_packages WHERE package_name = ?")
      .get(name) as PackageRow | undefined;
    if (!row || row.status === "installed") continue;
    const result = await installPackageById(row.id);
    if (result.success) installed.push(name);
    else failed.push(`${name}: ${result.error ?? "failed"}`);
  }
  return { installed, failed };
}
