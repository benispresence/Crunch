/**
 * Build a macOS .app into desktop/release/ (gitignored).
 *
 * Downloads a relocatable CPython and a Node binary into desktop/.pack
 * (also gitignored), installs Python deps with `pip install --target`,
 * compiles the frontend + backend, then runs electron-builder.
 *
 * Usage (from desktop/):
 *   npm run pack:mac
 *
 * Flags:
 *   --skip-python-bundle  use whatever python3 is on the user's PATH at runtime
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(desktopDir, "..");
const packDir = path.join(desktopDir, ".pack");
const skipPython = process.argv.includes("--skip-python-bundle");
const arch = process.arch === "arm64" ? "arm64" : "x64";

function run(cmd, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env, shell: process.platform === "win32" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    https.get(url, { headers: { "user-agent": "crunch-desktop-pack" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} → ${res.statusCode}`));
        return;
      }
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
    }).on("error", reject);
  });
}

async function extractTarGz(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", dest, "--strip-components=1"]);
}

const NODE_VERSION = process.versions.node;
const PYTHON_STANDALONE = {
  arm64: "https://github.com/astral-sh/python-build-standalone/releases/download/20250317/cpython-3.11.11+20250317-aarch64-apple-darwin-install_only.tar.gz",
  x64: "https://github.com/astral-sh/python-build-standalone/releases/download/20250317/cpython-3.11.11+20250317-x86_64-apple-darwin-install_only.tar.gz",
};

fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(path.join(packDir, "python"), { recursive: true });
fs.mkdirSync(path.join(packDir, "pydeps"), { recursive: true });
fs.mkdirSync(path.join(packDir, "node"), { recursive: true });

console.log("→ build frontend");
await run("npm", ["run", "build"], path.join(repo, "frontend"));

console.log("→ build backend");
await run("npm", ["run", "build"], path.join(repo, "backend"));

const nodeDir = path.join(packDir, "node");
const nodeBin = path.join(nodeDir, "bin", "node");
if (!fs.existsSync(nodeBin)) {
  console.log("→ download Node", NODE_VERSION, arch);
  const tar = path.join(packDir, `node-${NODE_VERSION}.tar.gz`);
  const nodeArch = arch === "arm64" ? "arm64" : "x64";
  await download(
    `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${nodeArch}.tar.gz`,
    tar,
  );
  await extractTarGz(tar, nodeDir);
}

if (!skipPython) {
  const pyDir = path.join(packDir, "python");
  const pyBin = path.join(pyDir, "bin", "python3");
  if (!fs.existsSync(pyBin)) {
    console.log("→ download CPython standalone", arch);
    const tar = path.join(packDir, `cpython-${arch}.tar.gz`);
    await download(PYTHON_STANDALONE[arch], tar);
    await extractTarGz(tar, pyDir);
  }
  const pydeps = path.join(packDir, "pydeps");
  if (!fs.existsSync(path.join(pydeps, "crunch")) && !fs.existsSync(path.join(pydeps, "fastapi"))) {
    console.log("→ pip install --target pydeps (this is the bulky step)");
    await run(pyBin, ["-m", "pip", "install", "--upgrade", "pip"], pyDir);
    // Install engine deps into a relocatable target dir. Do NOT
    // `pip install .` — pyproject pulls NiceGUI and other UI extras
    // the desktop engine never imports. PYTHONPATH=pydeps:src at runtime.
    await run(pyBin, [
      "-m", "pip", "install", "--target", pydeps,
      "fastapi", "uvicorn[standard]", "pydantic",
      "pandas", "numpy", "plotly", "duckdb", "openpyxl",
      "sqlalchemy[asyncio]", "greenlet",
      "asyncpg", "aiomysql", "aiosqlite",
    ], repo);
  }
}

console.log("→ electron-builder");
await run(
  path.join(desktopDir, "node_modules", ".bin", "electron-builder"),
  ["--mac", "dir", "--publish", "never"],
  desktopDir,
);

console.log("\nPacked app is under desktop/release/mac. Drag Crunch.app to /Applications.");
console.log("Unsigned: first open with right-click → Open (Gatekeeper).");
