import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const dist = resolve(root, "dist");
const archive = resolve(dist, `douyin-content-archive-v${manifest.version}.zip`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
execFileSync("zip", ["-r", "-X", archive, ".", "-x", "dist/*", ".git/*", ".github/*", "scripts/*", "node_modules/*", "*/.DS_Store", ".gitignore", "README.md", "package.json", "theme-preview.html", "icons/icon-source-*.png"], { cwd: root, stdio: "inherit" });
console.log(`已生成：${archive}`);
