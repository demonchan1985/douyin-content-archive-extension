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
    resolveSharedLink(message.value).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

async function archive({ items, date, keyword }) {
  const root = `${safeName(date)}_${safeName(keyword)}`;
  let downloaded = 0;
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    progress(`正在读取 ${index + 1}/${items.length}：${item.title}`);
    try {
      const detail = await inspectItem(item);
      if (!detail.media.length) throw new Error("未从作品详情中读取到可下载媒体");
      const title = detail.title || item.title;
      const author = detail.author || item.author;
      const folder = `${root}/${String(index + 1).padStart(3, "0")}_${item.id}_${safeName(title)}`;
      const metadata = { source_url: detail.sourceUrl, post_id: item.id, content_type: detail.contentType, title, author, archived_at: date, media_urls: detail.media, music_urls: detail.audio };
      await downloadText(JSON.stringify(metadata, null, 2), `${folder}/metadata.json`);
      for (let mediaIndex = 0; mediaIndex < detail.media.length; mediaIndex += 1) {
        const media = detail.media[mediaIndex];
        try {
          await chrome.downloads.download({ url: media, filename: `${folder}/${String(mediaIndex + 1).padStart(2, "0")}${extension(media, detail.contentType)}`, conflictAction: "uniquify", saveAs: false });
          downloaded += 1;
        } catch {
          failed += 1;
        }
      }
      for (let audioIndex = 0; audioIndex < detail.audio.length; audioIndex += 1) {
        const audio = detail.audio[audioIndex];
        try {
          await chrome.downloads.download({ url: audio, filename: `${folder}/music_${String(audioIndex + 1).padStart(2, "0")}${extension(audio, "audio")}`, conflictAction: "uniquify", saveAs: false });
          downloaded += 1;
        } catch {
          failed += 1;
        }
      }
    } catch (error) {
      failed += 1;
      progress(`跳过「${item.title}」：${error.message || "读取失败"}`);
    }
  }
  progress(`归档完成：${downloaded} 个媒体文件，${failed} 个未完成。`);
  return { downloaded, failed };
}

async function inspectItem(item) {
  const url = `https://www.douyin.com/${item.type === "image" ? "note" : "video"}/${item.id}`;
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id);
    await delay(2200);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectDetailMedia, args: [item.id] });
    if (!result) throw new Error("未能读取作品详情");
    return { sourceUrl: url, media: result.media || [], audio: result.audio || [], contentType: result.contentType || item.type, title: result.title || item.title, author: result.author || item.author, cover: result.cover || item.cover };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
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

  const firstUrl = (address) => (address?.url_list || []).find((url) => /^https:/.test(url)) || "";
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
  const video = firstUrl(aweme.video?.play_addr);
  const music = firstUrl(aweme.music?.play_url);
  return {
    media: images.length ? images : deduplicate([video]),
    audio: deduplicate([music]),
    contentType: images.length ? "image" : "video",
    title: aweme.desc || "抖音作品",
    author: aweme.author?.nickname || "未知作者",
    cover: images[0] || firstUrl(aweme.video?.cover),
  };
}

async function resolveSharedLink(value) {
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
  const detail = await inspectItem(parsed);
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
function progress(text) { chrome.runtime.sendMessage({ type: "archive-progress", text }).catch(() => {}); }
