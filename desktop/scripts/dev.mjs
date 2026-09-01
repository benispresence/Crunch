/**
 * Dev launcher: make sure the SPA is built, then open Electron.
 * Engine + backend are spawned by desktop/src/main.mjs from the repo.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(desktopDir, "..");
const frontendDist = path.join(repo, "frontend", "dist", "index.html");

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

if (!fs.existsSync(frontendDist)) {
  console.log("frontend/dist missing — building the SPA once so the desktop window has something to load.");
  await run("npm", ["run", "build"], path.join(repo, "frontend"));
}

const electron = path.join(desktopDir, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const child = spawn(electron, ["."], { cwd: desktopDir, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
