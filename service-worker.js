const pendingDownloads = new Map();
const requestedFilenames = new Map();
let lastArchiveDownloadId;

chrome.downloads.onDeterminingFilename.addListener((download, suggest) => {
  const requested = requestedFilenames.get(download.url) || requestedFilenames.get(download.finalUrl);
  if (requested) suggest({ filename: requested, conflictAction: "uniquify" });
});

chrome.downloads.onChanged.addListener((delta) => {
  const pending = pendingDownloads.get(delta.id);
  if (!pending) return;
  if (delta.bytesReceived || delta.totalBytes) {
    const received = delta.bytesReceived?.current ?? pending.received;
    const total = delta.totalBytes?.current ?? pending.total;
    pending.received = received;
    pending.total = total;
    if (total > 0) progress(`正在下载：${pending.label}（${Math.min(100, Math.round(received / total * 100))}%）`, Math.min(100, Math.round(received / total * 100)));
  }
  if (delta.state?.current === "complete") finishDownload(delta.id);
  if (delta.state?.current === "interrupted") finishDownload(delta.id, new Error(`下载中断：${delta.error?.current || "未知原因"}`));
});

function finishDownload(id, error) {
  const pending = pendingDownloads.get(id);
  if (!pending) return;
  pendingDownloads.delete(id);
  requestedFilenames.delete(pending.url);
  if (!error) {
    lastArchiveDownloadId = id;
    chrome.storage.session.set({ lastArchiveDownloadId: id }).catch(() => {});
  }
  error ? pending.reject(error) : pending.resolve();
}

async function downloadFile(options, label) {
  requestedFilenames.set(options.url, options.filename);
  let id;
  try {
    id = await chrome.downloads.download(options);
  } catch (error) {
    requestedFilenames.delete(options.url);
    throw error;
  }
  progress(`已创建下载任务：${label}`, 0);
  return new Promise((resolve, reject) => {
    pendingDownloads.set(id, { label, url: options.url, resolve, reject, received: 0, total: 0 });
    chrome.downloads.search({ id }).then(([download]) => {
      if (download?.state === "complete") finishDownload(id);
      if (download?.state === "interrupted") finishDownload(id, new Error(`下载中断：${download.error || "未知原因"}`));
    }).catch((error) => finishDownload(id, error));
  });
}

function isDouyinUrl(url) {
  return /^https:\/\/(?:www\.)?douyin\.com\//.test(url || "") || /^https:\/\/v\.douyin\.com\//.test(url || "");
}

async function disableSidePanelForTab(tabId) {
  if (tabId) await chrome.sidePanel.setOptions({ tabId, enabled: false });
}

async function setSidePanelForTab(tab) {
  if (!tab?.id) return;
  if (isDouyinUrl(tab.url)) {
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: "popup.html", enabled: true });
  } else {
    await disableSidePanelForTab(tab.id);
  }
}

async function configureSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.sidePanel.setOptions({ enabled: false });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => setSidePanelForTab(tab)));
}

configureSidePanel().catch((error) => console.warn("无法设置侧边栏：", error));
chrome.runtime.onInstalled.addListener(() => configureSidePanel().catch((error) => console.warn("无法设置侧边栏：", error)));
chrome.runtime.onStartup.addListener(() => configureSidePanel().catch((error) => console.warn("无法设置侧边栏：", error)));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    const updatedTab = { ...tab, url: changeInfo.url || tab.url };
    setSidePanelForTab(updatedTab).catch((error) => console.warn("无法更新侧边栏：", error));
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  await setSidePanelForTab(tab);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "archive") {
    archive(message).then(sendResponse).catch((error) => sendResponse({ downloaded: 0, failed: message.items.length, error: error.message }));
    return true;
  }
  if (message.type === "resolve-link") {
    resolveSharedLink(message.value, message.tabId).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "show-archive-folder") {
    showArchiveFolder().then(sendResponse).catch((error) => sendResponse({ shown: false, error: error.message }));
    return true;
  }
});

async function showArchiveFolder() {
  const { lastArchiveDownloadId: storedId } = await chrome.storage.session.get("lastArchiveDownloadId");
  const id = lastArchiveDownloadId || storedId;
  if (!id) throw new Error("本次归档没有可定位的媒体文件");
  const [download] = await chrome.downloads.search({ id });
  if (!download || download.state !== "complete") throw new Error("下载尚未完成");
  chrome.downloads.show(id);
  return { shown: true };
}

async function archive({ items, date, keyword }) {
  const root = `${safeName(date)}_${safeName(keyword)}`;
  let downloaded = 0;
  let failed = 0;
  const errors = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    progress(`正在读取 ${index + 1}/${items.length}：${item.title}`);
    try {
      const detail = await inspectItem(item);
      if (!detail.media.length) throw new Error("未从作品详情中读取到可下载媒体");
      const title = detail.title || item.title;
      const fileTitle = safeName(title);
      const author = detail.author || item.author;
      const folder = `${root}/${String(index + 1).padStart(3, "0")}_${item.id}_${safeName(title)}`;
      const metadata = { source_url: detail.sourceUrl, post_id: item.id, content_type: detail.contentType, title, author, archived_at: date, media_urls: detail.media, video_candidates: detail.videoCandidates || [], music_urls: detail.audio };
      const metadataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(metadata, null, 2))}`;
      await downloadFile({ url: metadataUrl, filename: `${folder}/${fileTitle}_信息.json`, conflictAction: "uniquify", saveAs: false }, `${index + 1}/${items.length}「${title}」信息`);
      for (let mediaIndex = 0; mediaIndex < detail.media.length; mediaIndex += 1) {
        const media = detail.media[mediaIndex];
        try {
          const suffix = detail.contentType === "video" ? "" : `_${String(mediaIndex + 1).padStart(2, "0")}`;
          const filename = `${folder}/${fileTitle}${suffix}${extension(media, detail.contentType)}`;
          const sources = detail.contentType === "video" ? detail.videoCandidates : [media];
          await downloadWithFallback(sources, { filename, conflictAction: "uniquify", saveAs: false }, `${index + 1}/${items.length}「${title}」媒体 ${mediaIndex + 1}/${detail.media.length}`);
          downloaded += 1;
        } catch (error) {
          failed += 1;
          errors.push(`「${title}」媒体下载失败：${error.message || "未知原因"}`);
        }
      }
      for (let audioIndex = 0; detail.contentType === "image" && audioIndex < detail.audio.length; audioIndex += 1) {
        const audio = detail.audio[audioIndex];
        try {
          await downloadFile({ url: audio, filename: `${folder}/${fileTitle}_配乐_${String(audioIndex + 1).padStart(2, "0")}${extension(audio, "audio")}`, conflictAction: "uniquify", saveAs: false }, `${index + 1}/${items.length}「${title}」配乐 ${audioIndex + 1}/${detail.audio.length}`);
          downloaded += 1;
        } catch (error) {
          failed += 1;
          errors.push(`「${title}」配乐下载失败：${error.message || "未知原因"}`);
        }
      }
    } catch (error) {
      failed += 1;
      errors.push(`「${item.title}」读取失败：${error.message || "未知原因"}`);
      progress(`跳过「${item.title}」：${error.message || "读取失败"}`);
    }
  }
  progress(`归档完成：${downloaded} 个媒体文件，${failed} 个未完成。`, 100);
  return { downloaded, failed, errors };
}

async function inspectItem(item, existingTabId) {
  const url = `https://www.douyin.com/${item.type === "image" ? "note" : "video"}/${item.id}`;
  const tab = existingTabId ? await chrome.tabs.get(existingTabId) : await chrome.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id);
    await delay(2200);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectDetailMedia, args: [item.id] });
    if (!result) throw new Error("未能读取作品详情");
    return { sourceUrl: url, media: result.media || [], videoCandidates: result.videoCandidates || [], audio: result.audio || [], contentType: result.contentType || item.type, title: result.title || item.title, author: result.author || item.author, cover: result.cover || item.cover };
  } finally {
    if (!existingTabId) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function collectDetailMedia(awemeId) {
  const params = new URLSearchParams({
    device_platform: "webapp", aid: "6383", channel: "channel_pc_web", pc_client_type: "1",
    version_code: "190500", version_name: "19.5.0", cookie_enabled: "true", browser_language: "zh-CN",
    browser_platform: "Win32", browser_name: "Edge", browser_online: "true", engine_name: "Blink",
    os_name: "Windows", os_version: "10", platform: "PC", screen_width: "1920", screen_height: "1080", aweme_id: awemeId,
  });
  const response = await fetch(`/aweme/v1/web/aweme/detail/?${params}`, { credentials: "include" });
  if (!response.ok) throw new Error(`作品详情请求失败 (${response.status})`);
  const payload = await response.json();
  const aweme = payload.aweme_detail;
  if (!aweme) throw new Error(payload.status_msg || "作品详情为空");

  const urls = (address) => (address?.url_list || []).filter((url) => /^https:/.test(url));
  const firstUrl = (address) => urls(address)[0] || "";
  const deduplicate = (urls) => {
    const keys = new Set();
    return urls.filter((url) => {
      if (!url) return false;
      const key = url.split("?")[0];
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
  };
  const images = deduplicate((aweme.images || []).map((image) => firstUrl(image)));
  const videoCandidates = deduplicate([
    ...urls(aweme.video?.play_addr_h264),
    ...urls(aweme.video?.play_addr),
    ...(aweme.video?.bit_rate || []).flatMap((bitRate) => [...urls(bitRate.play_addr_h264), ...urls(bitRate.play_addr)]),
  ]).sort((left, right) => Number(/www\.douyin\.com\/aweme\/v1\/play/i.test(right)) - Number(/www\.douyin\.com\/aweme\/v1\/play/i.test(left)));
  const video = videoCandidates[0] || "";
  const music = firstUrl(aweme.music?.play_url);
  return {
    media: images.length ? images : deduplicate([video]),
    videoCandidates,
    audio: deduplicate([music]),
    contentType: images.length ? "image" : "video",
    title: aweme.desc || "抖音作品",
    author: aweme.author?.nickname || "未知作者",
    cover: images[0] || firstUrl(aweme.video?.cover),
  };
}

async function downloadWithFallback(urls, options, label) {
  let lastError;
  for (let index = 0; index < urls.length; index += 1) {
    try {
      if (index) progress(`正在切换备用视频地址 ${index + 1}/${urls.length}：${label}`, 0);
      await downloadFile({ ...options, url: urls[index] }, label);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("没有可用的视频下载地址");
}

async function resolveSharedLink(value, existingTabId) {
  const sharedUrl = extractUrl(value);
  if (!sharedUrl) throw new Error("未找到有效的抖音链接");
  let parsed = parseAwemeUrl(sharedUrl);
  if (!parsed) {
    const tab = await chrome.tabs.create({ url: sharedUrl, active: false });
    try {
      await waitForLoad(tab.id);
      await delay(1200);
      const resolvedTab = await chrome.tabs.get(tab.id);
      parsed = parseAwemeUrl(resolvedTab.url || "");
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  if (!parsed) throw new Error("链接未跳转到可识别的抖音图文或视频作品");
  const detail = await inspectItem(parsed, existingTabId);
  if (!detail.media.length) throw new Error("作品未提供可下载媒体");
  return { item: { id: parsed.id, type: detail.contentType, title: detail.title, author: detail.author, cover: detail.cover } };
}

function extractUrl(value) {
  return String(value || "").match(/https?:\/\/[^\s<>'"，。；！]+/i)?.[0] || "";
}

function parseAwemeUrl(value) {
  const match = String(value).match(/douyin\.com\/(note|video)\/(\d+)/i);
  if (!match) return null;
  return { type: match[1].toLowerCase() === "note" ? "image" : "video", id: match[2] };
}

async function waitForLoad(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("详情页加载超时")), 20000);
    const onUpdated = (updatedTabId, changeInfo) => { if (updatedTabId === tabId && changeInfo.status === "complete") finish(); };
    const finish = (error) => { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(onUpdated); error ? reject(error) : resolve(); };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function downloadText(text, filename) {
  return chrome.downloads.download({ url: `data:application/json;charset=utf-8,${encodeURIComponent(text)}`, filename, conflictAction: "uniquify", saveAs: false });
}
function safeName(value) { return String(value || "未命名").replace(/[\\/:*?"<>|\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 42) || "未命名"; }
function extension(url, type) { const match = url.match(/\.(webp|png|jpe?g|mp3|m4a|aac|ogg|wav)(?:\?|$)/i); if (match) return `.${match[1].replace("jpeg", "jpg")}`; if (type === "video") return ".mp4"; if (type === "audio") return ".m4a"; return ".webp"; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function progress(text, percent) { chrome.runtime.sendMessage({ type: "archive-progress", text, percent }).catch(() => {}); }
