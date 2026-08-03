import { db } from "../db/index.js";

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
  return rows.map((r) => r.name);
}

/** True when the row is a Python stdlib module — no pip, no version. */
export function isStdlibRow(installedVersion: string | null | undefined): boolean {
  return installedVersion === "stdlib";
}
