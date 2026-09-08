/**
 * Copy a Crunch SQLite database into the desktop app and re-encrypt
 * `enc:v1:` secrets for this app's DATA_KEY.
 *
 * The browser/dev instance and the Mac app use different keys (dev
 * derives from JWT_SECRET; the app generates a random DATA_KEY). A
 * raw file copy would leave connection passwords and API keys
 * undecryptable. VACUUM INTO gives a consistent snapshot even if the
 * source is still open.
 *
 * Env:
 *   CRUNCH_IMPORT_FROM              source nicemeta.sqlite
 *   CRUNCH_IMPORT_TO                dest nicemeta.sqlite (must not exist)
 *   CRUNCH_IMPORT_FROM_DATA_KEY     optional
 *   CRUNCH_IMPORT_FROM_JWT_SECRET   used when DATA_KEY is empty (dev)
 *   CRUNCH_IMPORT_TO_DATA_KEY
 *   CRUNCH_IMPORT_TO_JWT_SECRET     unused if DATA_KEY is set
 *   CRUNCH_BACKEND_NODE_MODULES     path to backend/node_modules
 *   CRUNCH_IMPORT_FROM_WORKSPACE    optional directory to copy
 *   CRUNCH_IMPORT_TO_WORKSPACE
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const PREFIX = "enc:v1:";
const ALG = "aes-256-gcm";

function env(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : "";
}

function deriveKey(dataKey, jwtSecret) {
  if (dataKey) {
    if (/^[0-9a-fA-F]{64}$/.test(dataKey)) return Buffer.from(dataKey, "hex");
    const b = Buffer.from(dataKey, "base64");
    if (b.length === 32) return b;
    return crypto.scryptSync(dataKey, "crunch-data-key", 32);
  }
  const secret = jwtSecret || "dev-secret-change-me";
  return crypto.scryptSync(secret, "crunch-dev-data-key", 32);
}

function encryptWith(plaintext, key) {
  if (!plaintext) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

function decryptWith(value, key) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function rekeyString(value, fromKey, toKey) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return { value, changed: false };
  const plain = decryptWith(value, fromKey);
  return { value: encryptWith(plain, toKey), changed: true };
}

function walkJson(node, fromKey, toKey) {
  let changed = 0;
  const visit = (v) => {
    if (typeof v === "string") {
      const r = rekeyString(v, fromKey, toKey);
      if (r.changed) changed += 1;
      return r.value;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = visit(val);
      return out;
    }
    return v;
  };
  return { value: visit(node), changed };
}

function rekeyCell(raw, fromKey, toKey) {
  if (typeof raw !== "string" || raw === "") return { value: raw, changed: 0 };
  if (raw.startsWith(PREFIX)) {
    const r = rekeyString(raw, fromKey, toKey);
    return { value: r.value, changed: r.changed ? 1 : 0 };
  }
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(raw);
      const walked = walkJson(parsed, fromKey, toKey);
      if (walked.changed === 0) return { value: raw, changed: 0 };
      return { value: JSON.stringify(walked.value), changed: walked.changed };
    } catch {
      return { value: raw, changed: 0 };
    }
  }
  return { value: raw, changed: 0 };
}

function sqlLiteral(filePath) {
  return `'${path.resolve(filePath).replaceAll("'", "''")}'`;
}

function loadBetterSqlite() {
  const nm = env("CRUNCH_BACKEND_NODE_MODULES");
  if (!nm) throw new Error("CRUNCH_BACKEND_NODE_MODULES is not set");
  const pkg = path.join(nm, "better-sqlite3", "package.json");
  if (!fs.existsSync(pkg)) {
    throw new Error(`better-sqlite3 not found in ${nm}`);
  }
  const require = createRequire(pkg);
  return require("better-sqlite3");
}

function copyWorkspace(fromDir, toDir) {
  if (!fromDir || !toDir || !fs.existsSync(fromDir)) return false;
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  if (fs.existsSync(toDir)) {
    const bak = `${toDir}.bak-${stamp()}`;
    fs.renameSync(toDir, bak);
  }
  fs.cpSync(fromDir, toDir, { recursive: true, force: true });
  return true;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function main() {
  const from = env("CRUNCH_IMPORT_FROM");
  const to = env("CRUNCH_IMPORT_TO");
  if (!from || !to) throw new Error("CRUNCH_IMPORT_FROM and CRUNCH_IMPORT_TO are required");
  if (!fs.existsSync(from)) throw new Error(`source database not found: ${from}`);
  if (fs.existsSync(to)) throw new Error(`destination already exists: ${to}`);

  const Database = loadBetterSqlite();
  fs.mkdirSync(path.dirname(to), { recursive: true });

  const src = new Database(from, { readonly: true, fileMustExist: true });
  try {
    try {
      src.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // Source may not be in WAL mode; snapshot still works.
    }
    src.exec(`VACUUM INTO ${sqlLiteral(to)}`);
  } finally {
    src.close();
  }

  const fromKey = deriveKey(env("CRUNCH_IMPORT_FROM_DATA_KEY"), env("CRUNCH_IMPORT_FROM_JWT_SECRET"));
  const toKey = deriveKey(env("CRUNCH_IMPORT_TO_DATA_KEY"), env("CRUNCH_IMPORT_TO_JWT_SECRET"));

  const dest = new Database(to);
  dest.pragma("journal_mode = WAL");
  let rekeyed = 0;
  const tables = dest
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  try {
    const tx = dest.transaction(() => {
      for (const table of tables) {
        const cols = dest.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
        const textCols = cols.filter((c) => {
          const t = String(c.type || "").toUpperCase();
          return t === "" || t.includes("CHAR") || t.includes("TEXT") || t.includes("CLOB") || t === "JSON";
        });
        if (textCols.length === 0) continue;
        const pk = cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        const idCols = pk.length > 0 ? pk : ["rowid"];
        const selectCols = [...new Set([...idCols, ...textCols.map((c) => c.name)])];
        const rows = dest.prepare(
          `SELECT ${selectCols.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`,
        ).all();
        for (const row of rows) {
          const sets = [];
          const params = {};
          for (const col of textCols) {
            const cell = row[col.name];
            if (typeof cell !== "string" || cell === "") continue;
            try {
              const next = rekeyCell(cell, fromKey, toKey);
              if (next.changed === 0) continue;
              rekeyed += next.changed;
              const bind = `v_${col.name}`;
              sets.push(`${quoteIdent(col.name)} = @${bind}`);
              params[bind] = next.value;
            } catch (err) {
              throw new Error(
                `Could not decrypt ${table}.${col.name} with the source key. `
                + `Pick the nicemeta.sqlite that sits next to that instance's .env `
                + `(usually backend/nicemeta.sqlite). ${err instanceof Error ? err.message : err}`,
              );
            }
          }
          if (sets.length === 0) continue;
          const where = idCols.map((c, i) => {
            params[`k_${i}`] = row[c];
            return `${quoteIdent(c)} = @k_${i}`;
          }).join(" AND ");
          dest.prepare(
            `UPDATE ${quoteIdent(table)} SET ${sets.join(", ")} WHERE ${where}`,
          ).run(params);
        }
      }
    });
    tx();
  } finally {
    dest.close();
  }

  const workspaceCopied = copyWorkspace(
    env("CRUNCH_IMPORT_FROM_WORKSPACE"),
    env("CRUNCH_IMPORT_TO_WORKSPACE"),
  );

  process.stdout.write(JSON.stringify({
    ok: true,
    tables: tables.length,
    rekeyed,
    workspaceCopied,
  }) + "\n");
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

try {
  main();
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
}
