/**
 * Center-crop frontend/public/logo.png to a 1024 square and build
 * desktop/build/icon.icns for the Mac app / Dock.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(desktopDir, "..");
const logo = path.join(repo, "frontend", "public", "logo.png");
const build = path.join(desktopDir, "build");
const png = path.join(build, "icon.png");
const icns = path.join(build, "icon.icns");
const iconset = path.join(build, "icon.iconset");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

if (process.platform !== "darwin") {
  console.log("Skipping Mac icon generation (sips/iconutil are macOS-only).");
  process.exit(0);
}

fs.mkdirSync(build, { recursive: true });
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);

run("sips", ["-c", "1024", "1024", logo, "--out", png]);

const sizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [px, name] of sizes) {
  run("sips", ["-z", String(px), String(px), png, "--out", path.join(iconset, name)]);
}
run("iconutil", ["-c", "icns", iconset, "-o", icns]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log("wrote", png, "and", icns);
