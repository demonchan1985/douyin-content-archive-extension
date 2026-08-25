import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const requiredFiles = ["popup.html", "popup.js", "popup.css", "service-worker.js", "icons/icon-128.png"];

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) throw new Error(`缺少发布文件：${file}`);
}

const tag = process.env.GITHUB_REF_NAME;
if (tag && tag.startsWith("v") && tag !== `v${manifest.version}`) {
  throw new Error(`发布标签 ${tag} 必须与 manifest 版本 v${manifest.version} 一致`);
}

console.log(`发布检查通过：v${manifest.version}`);
