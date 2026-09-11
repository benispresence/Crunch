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
import crypto from "node:crypto";
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
const arch = process.argv.find((arg) => arg.startsWith("--arch="))?.split("=")[1] ?? process.arch;
if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch) || arch !== process.arch) {
  throw new Error(`Build on a native ${arch} Mac with matching Node (got ${process.platform}/${process.arch}).`);
}

function run(cmd, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env, shell: process.platform === "win32" });
    child.on("error", reject);
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

// A cached interpreter or native wheel from another architecture cannot be reused.
const requirementsFile = path.join(desktopDir, "requirements-engine.txt");
const requirementsHash = crypto.createHash("sha256").update(fs.readFileSync(requirementsFile)).digest("hex");
const cacheKey = `${arch}-node-${NODE_VERSION}-${requirementsHash}`;
const cacheFile = path.join(packDir, "runtime-version");
if (fs.existsSync(packDir) && (!fs.existsSync(cacheFile) || fs.readFileSync(cacheFile, "utf8") !== cacheKey)) {
  fs.rmSync(packDir, { recursive: true, force: true });
}
fs.mkdirSync(packDir, { recursive: true });
fs.writeFileSync(cacheFile, cacheKey);
fs.mkdirSync(path.join(packDir, "python"), { recursive: true });
fs.mkdirSync(path.join(packDir, "pydeps"), { recursive: true });
fs.mkdirSync(path.join(packDir, "node"), { recursive: true });

console.log("→ app icon from Crunch logo");
await run(process.execPath, [path.join(desktopDir, "scripts", "generate-icon.mjs")], desktopDir);

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
  const depsComplete = path.join(packDir, "pydeps-complete");
  if (!fs.existsSync(depsComplete)) {
    fs.rmSync(pydeps, { recursive: true, force: true });
    console.log("→ pip install --target pydeps (this is the bulky step)");
    await run(pyBin, ["-m", "pip", "install", "--upgrade", "pip"], pyDir);
    // Install engine deps into a relocatable target dir. Do NOT
    // `pip install .` — pyproject pulls NiceGUI and other UI extras
    // the desktop engine never imports. PYTHONPATH=pydeps:src at runtime.
    await run(pyBin, [
      "-m", "pip", "install", "--target", pydeps,
      "-r", requirementsFile,
    ], repo);
    fs.writeFileSync(depsComplete, requirementsHash);
  }
}

console.log("→ electron-builder (zip for this Mac:", arch, ")");
await run(
  path.join(desktopDir, "node_modules", ".bin", "electron-builder"),
  ["--mac", "zip", `--${arch}`, "--publish", "never"],
  desktopDir,
  { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
);

const appPath = path.join(desktopDir, "release", arch === "arm64" ? "mac-arm64" : "mac", "Crunch.app");
await run(process.execPath, [path.join(desktopDir, "scripts", "verify-mac.mjs"), appPath, arch], desktopDir);

const label = arch === "arm64" ? "apple-silicon" : "intel";
const zips = fs.readdirSync(path.join(desktopDir, "release"))
  .filter((f) => f.endsWith(".zip"))
  .map((f) => path.join(desktopDir, "release", f));
console.log("\nDownloadable file(s) for this machine (" + label + "):");
for (const z of zips) {
  const mb = (fs.statSync(z).size / (1024 * 1024)).toFixed(1);
  console.log("  " + z + "  (" + mb + " MB)");
}
console.log("Send that zip. Recipients unzip, then right-click Crunch.app → Open.");
console.log("Intel and Apple Silicon are different zips — pack on each arch (or GitHub Actions).");
