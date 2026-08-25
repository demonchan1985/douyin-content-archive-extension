# 抖音内容归档 Chrome 扩展

## 用户安装与更新

- 正式用户：请从 Chrome Web Store 安装。后续版本由 Chrome 自动更新。
- 测试用户：可从 GitHub Releases 下载 ZIP，解压后按下方“开发者安装”加载；此方式需要手动重新下载新版本。

发布者在修改扩展后，先递增 `manifest.json` 的 `version`，再创建同名 Git 标签（例如 `v0.1.1`）并推送。GitHub Actions 会校验版本、打包 ZIP 并创建对应的 Release。

```bash
npm run check
npm run package
git tag v0.1.1
git push origin v0.1.1
```

Chrome Web Store 的首次提交和每次版本发布，需要在 Chrome Web Store 开发者后台上传 `dist/` 中生成的 ZIP。

## 开发者安装

1. 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本目录。
3. 打开抖音搜索结果页，点击扩展图标，设置筛选后依次点击“扫描”和“下载”。

媒体与 `metadata.json` 会写入 Chrome 默认下载目录下的 `日期_搜索词/序号_内容ID_标题/`。图文附带的可读取音乐会另存为 `music_01` 等文件。在扩展中点击“选择下载位置”会打开 Chrome 下载设置，可更改默认下载文件夹。扩展不保存账号 Cookie；视频和图文音乐下载依赖详情页暴露的可下载媒体地址。
