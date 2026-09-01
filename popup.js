const filters = { sort: "最多点赞", time: "不限时间", scope: "不限范围", duration: "不限时长", format: "不限" };
const filterStorageKey = "lastFilters";
const themeStorageKey = "themeMode";
const scanLimitStorageKey = "scanLimit";
const videoDownloadModeStorageKey = "videoDownloadMode";
let scannedItems = [];
let selectedIds = new Set();
let pageSyncTask = Promise.resolve();
let themeMode = "system";
let videoDownloadMode = "video";
const extensionApiAvailable = Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);

const $ = (selector) => document.querySelector(selector);
const dateInput = $("#archive-date");
const downloadProgress = $("#download-progress");
const downloadStatus = $("#download-status");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const scanLimitSelect = $("#scan-limit");
const scanLimitCustom = $("#scan-limit-custom");
dateInput.value = new Date().toLocaleDateString("en-CA");

function applyTheme(mode) {
  themeMode = mode;
  document.documentElement.dataset.theme = mode === "system" ? (systemTheme.matches ? "dark" : "light") : mode;
  document.querySelectorAll(".theme-options button").forEach((button) => button.classList.toggle("selected", button.dataset.theme === mode));
}

async function restoreTheme() {
  if (extensionApiAvailable) {
    const { [themeStorageKey]: storedTheme } = await chrome.storage.local.get(themeStorageKey);
    if (["system", "light", "dark"].includes(storedTheme)) themeMode = storedTheme;
  }
  applyTheme(themeMode);
}

function updateSummary() {
  $("#filter-summary").textContent = `${filters.format} · ${filters.sort} · ${filters.time}`;
}

function updateFilterButtons() {
  Object.entries(filters).forEach(([group, value]) => {
    document.querySelectorAll(`.options button[data-group="${group}"]`).forEach((item) => {
      item.classList.toggle("selected", item.dataset.value === value);
    });
  });
}

async function restoreLastFilters() {
  if (!extensionApiAvailable) return;
  const stored = await chrome.storage.local.get([filterStorageKey, "lastSort"]);
  const lastFilters = stored[filterStorageKey] || (stored.lastSort ? { sort: stored.lastSort } : null);
  if (lastFilters) Object.entries(filters).forEach(([group]) => {
    const value = lastFilters[group];
    if (value && document.querySelector(`.options button[data-group="${group}"][data-value="${value}"]`)) filters[group] = value;
  });
  updateFilterButtons();
  updateSummary();
}

function getScanLimit() {
  const value = scanLimitSelect.value === "custom" ? Number(scanLimitCustom.value) : Number(scanLimitSelect.value);
  if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error("扫描数量请输入 1–500 之间的整数");
  return value;
}

function updateScanLimit() {
  const custom = scanLimitSelect.value === "custom";
  scanLimitCustom.hidden = !custom;
  const limit = custom ? Number(scanLimitCustom.value) || 50 : Number(scanLimitSelect.value);
  $("#scan-button").textContent = `扫描前 ${limit} 条内容`;
}

async function restoreScanLimit() {
  if (!extensionApiAvailable) return;
  const { [scanLimitStorageKey]: saved } = await chrome.storage.local.get(scanLimitStorageKey);
  if (Number.isInteger(saved) && saved >= 1 && saved <= 500) {
    if (document.querySelector(`#scan-limit option[value="${saved}"]`)) scanLimitSelect.value = String(saved);
    else {
      scanLimitSelect.value = "custom";
      scanLimitCustom.value = saved;
    }
  }
  updateScanLimit();
}

function updateVideoDownloadButtons() {
  document.querySelectorAll("[data-video-download-mode]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.videoDownloadMode === videoDownloadMode);
  });
}

async function restoreVideoDownloadMode() {
  if (extensionApiAvailable) {
    const { [videoDownloadModeStorageKey]: storedMode } = await chrome.storage.local.get(videoDownloadModeStorageKey);
    if (["video", "both", "audio"].includes(storedMode)) videoDownloadMode = storedMode;
  }
  updateVideoDownloadButtons();
}

function setMessage(message, error = false) {
  const target = $("#message");
  target.hidden = false;
  target.textContent = message;
  target.classList.toggle("error", error);
}

function showDownloadProgress(detail, percent = 0) {
  $("#message").hidden = true;
  downloadStatus.hidden = false;
  downloadStatus.classList.remove("completed");
  $("#download-state").textContent = "↓";
  $("#download-status-title").textContent = "正在归档";
  $("#download-status-detail").textContent = detail;
  $("#download-percent").textContent = `${percent}%`;
  $("#download-status-meta").textContent = `${percent}% 已完成`;
  downloadProgress.value = percent;
}

function showDownloadComplete(response) {
  downloadStatus.hidden = false;
  downloadStatus.classList.add("completed");
  $("#download-state").textContent = "✓";
  $("#download-status-title").textContent = response.failed ? "归档完成（部分失败）" : "归档已完成";
  $("#download-status-detail").textContent = `${response.downloaded} 个媒体文件 · ${response.failed} 个未下载`;
  $("#download-done-text").textContent = `✓ 已完成：${response.downloaded} 个媒体文件`;
  $("#open-download-folder").disabled = !response.downloaded;
}

function renderResults(items) {
  const list = $("#result-list");
  selectedIds = new Set(items.map((item) => item.id));
  list.replaceChildren(...items.map((item) => {
    const row = document.createElement("label");
    row.className = "result";
    const checkbox = document.createElement("input");
    checkbox.className = "item-selector";
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () => {
      checkbox.checked ? selectedIds.add(item.id) : selectedIds.delete(item.id);
      updateSelection();
    });
    const thumbnail = document.createElement("span");
    thumbnail.className = "thumbnail";
    if (item.cover) {
      const image = document.createElement("img");
      image.src = item.cover;
      image.alt = "";
      thumbnail.append(image);
    }
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = item.type === "image" ? "▦" : "▶";
    thumbnail.append(kind);
    const details = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = item.title;
    const author = document.createElement("small");
    author.textContent = `@${item.author || "未知作者"} · ${item.type === "image" ? "图文" : "视频"}`;
    details.append(title, author);
    row.append(checkbox, thumbnail, details);
    return row;
  }));
  updateSelection();
  $("#results").hidden = false;
}

function updateSelection() {
  $("#result-count").textContent = `${selectedIds.size}/${scannedItems.length} 条已选`;
  $("#archive-button").textContent = selectedIds.size ? `下载已选内容（${selectedIds.size}）` : "下载已选内容";
}

$("#filter-toggle").addEventListener("click", () => {
  const expanded = $("#filter-toggle").getAttribute("aria-expanded") === "true";
  $("#filter-toggle").setAttribute("aria-expanded", String(!expanded));
  $("#filter-panel").hidden = expanded;
});

document.querySelectorAll(".theme-options button").forEach((button) => {
  button.addEventListener("click", () => {
    applyTheme(button.dataset.theme);
    if (extensionApiAvailable) chrome.storage.local.set({ [themeStorageKey]: themeMode });
  });
});

systemTheme.addEventListener("change", () => {
  if (themeMode === "system") applyTheme("system");
});

document.querySelectorAll(".options button[data-group]").forEach((option) => {
  option.addEventListener("click", () => {
    const { group, value } = option.dataset;
    filters[group] = value;
    updateFilterButtons();
    if (extensionApiAvailable) chrome.storage.local.set({ [filterStorageKey]: { ...filters } });
    updateSummary();
    if (extensionApiAvailable) syncFiltersToCurrentSearchPage().catch((error) => setMessage(`网页筛选未同步：${error.message}`, true));
  });
});

async function initializePanel() {
  await Promise.all([restoreLastFilters(), restoreTheme(), restoreScanLimit(), restoreVideoDownloadMode()]);
  if (!extensionApiAvailable) return;
  const singleItem = await updateScanMode();
  if (singleItem) {
    setMessage("点击“识别当前作品”即可加入下载队列。");
    return;
  }
  try {
    await syncFiltersToCurrentSearchPage();
  } catch (error) {
    setMessage(`网页筛选未同步：${error.message}`, true);
  }
}

initializePanel().catch((error) => setMessage(`初始化失败：${error.message}`, true));

function isSingleAwemePage(url) {
  return /^https:\/\/(?:www\.)?douyin\.com\/(?:note|video)\/\d+/i.test(url || "");
}

async function updateScanMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const singleItem = isSingleAwemePage(tab?.url);
  $("#scan-limit-row").hidden = singleItem;
  if (singleItem) $("#scan-button").textContent = "识别当前作品";
  else updateScanLimit();
  return singleItem;
}

scanLimitSelect.addEventListener("change", () => {
  updateScanLimit();
  if (scanLimitSelect.value !== "custom" && extensionApiAvailable) chrome.storage.local.set({ [scanLimitStorageKey]: Number(scanLimitSelect.value) });
});

scanLimitCustom.addEventListener("change", () => {
  updateScanLimit();
  const value = Number(scanLimitCustom.value);
  if (Number.isInteger(value) && value >= 1 && value <= 500 && extensionApiAvailable) chrome.storage.local.set({ [scanLimitStorageKey]: value });
});

document.querySelectorAll("[data-video-download-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    videoDownloadMode = button.dataset.videoDownloadMode;
    updateVideoDownloadButtons();
    if (extensionApiAvailable) chrome.storage.local.set({ [videoDownloadModeStorageKey]: videoDownloadMode });
  });
});

$("#open-download-settings").addEventListener("click", async () => {
  if (!extensionApiAvailable) {
    setMessage("预览页无法设置下载位置；请在 chrome://extensions 加载扩展后使用。", true);
    return;
  }
  await chrome.tabs.create({ url: "chrome://settings/downloads" });
});

$("#read-clipboard").addEventListener("click", async () => {
  try {
    const value = await navigator.clipboard.readText();
    if (!value.trim()) throw new Error("剪贴板中没有可用内容");
    $("#shared-link").value = value.trim();
    setMessage("已读取剪贴板内容，可点击解析链接。");
  } catch (error) {
    setMessage(`无法读取剪贴板：${error.message}`, true);
  }
});

$("#parse-link").addEventListener("click", async () => {
  const value = $("#shared-link").value.trim();
  if (!value) {
    setMessage("请先粘贴抖音作品链接或分享文案。", true);
    return;
  }
  $("#parse-link").disabled = true;
  setMessage("正在解析抖音链接…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "resolve-link", value });
    if (!response?.item) throw new Error(response?.error || "未识别到可下载作品");
    scannedItems = [response.item];
    $("#page-name").textContent = "链接下载 · 单条作品";
    $("#root-name").textContent = `${dateInput.value}_链接下载`;
    renderResults(scannedItems);
    setMessage("链接已解析，确认勾选后点击下载已选内容。");
  } catch (error) {
    setMessage(`链接解析失败：${error.message}`, true);
  } finally {
    $("#parse-link").disabled = false;
  }
});

$("#scan-button").addEventListener("click", async () => {
  if (!extensionApiAvailable) {
    setMessage("这是本地预览页。请在 chrome://extensions 加载扩展后，打开抖音搜索页再扫描。", true);
    return;
  }
  let scanLimit;
  try {
    scanLimit = getScanLimit();
  } catch (error) {
    setMessage(error.message, true);
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://www.douyin.com/")) {
    setMessage("请先打开抖音搜索结果页或单个作品页，再扫描。", true);
    return;
  }
  $("#scan-button").disabled = true;
  try {
    if (isSingleAwemePage(tab.url)) {
      setMessage("正在识别当前作品…");
      const response = await chrome.runtime.sendMessage({ type: "resolve-link", value: tab.url, tabId: tab.id });
      if (!response?.item) throw new Error(response?.error || "未识别到可下载作品");
      scannedItems = [response.item];
      $("#page-name").textContent = "单个作品 · 当前页面";
      $("#root-name").textContent = `${dateInput.value}_单个作品`;
      renderResults(scannedItems);
      setMessage("已识别当前作品，确认勾选后点击下载已选内容。");
      return;
    }
    setMessage("正在校验并同步网页筛选…");
    const syncResult = await syncFiltersToCurrentSearchPage();
    if (!syncResult.synced) throw new Error(syncResult.error || "当前网页未能同步筛选");
    setMessage(`网页筛选已同步，正在读取前 ${scanLimit} 条内容…`);
    await wait(700);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanSearchPage, args: [filters, scanLimit] });
    scannedItems = result.items;
    $("#page-name").textContent = `${result.keyword} · 当前搜索页`;
    $("#root-name").textContent = `${dateInput.value}_${result.keyword}`;
    if (!scannedItems.length) {
      $("#results").hidden = true;
      setMessage("没有找到符合条件的已加载内容；可展开筛选后重试。", true);
      return;
    }
    renderResults(scannedItems);
    setMessage(`已扫描 ${result.scanned} 条，符合筛选 ${scannedItems.length} 条；确认后开始下载。`);
  } catch (error) {
    setMessage(`扫描失败：${error.message}`, true);
  } finally {
    $("#scan-button").disabled = false;
  }
});

function syncFiltersToCurrentSearchPage() {
  pageSyncTask = pageSyncTask.catch(() => {}).then(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://www.douyin.com/search")) {
      return { synced: false, error: "请先打开抖音搜索结果页" };
    }
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyFiltersToSearchPage, args: [filters] });
    if (!result?.synced) throw new Error(result?.error || "抖音网页未响应筛选操作");
    setMessage("筛选已同步到当前抖音网页。");
    return result;
  });
  return pageSyncTask;
}

$("#archive-button").addEventListener("click", async () => {
  const selectedItems = scannedItems.filter((item) => selectedIds.has(item.id));
  if (!selectedItems.length) {
    setMessage("请至少勾选一条内容再下载。", true);
    return;
  }
  $("#archive-button").disabled = true;
  showDownloadProgress("正在创建下载任务…");
  const keyword = $("#page-name").textContent.split(" · ")[0] || "抖音搜索";
  try {
    const response = await chrome.runtime.sendMessage({ type: "archive", items: selectedItems, filters, date: dateInput.value, keyword, videoDownloadMode });
    const firstError = response.errors?.[0] ? ` ${response.errors[0]}` : "";
    showDownloadComplete(response);
    if (response.failed) setMessage(`部分内容未下载。${firstError}`, true);
  } catch (error) {
    $("#message").hidden = false;
    setMessage(`归档失败：${error.message}`, true);
  } finally {
    $("#archive-button").disabled = false;
  }
});

$("#open-download-folder").addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "show-archive-folder" });
    if (!response?.shown) throw new Error(response?.error || "未找到本次下载文件");
  } catch (error) {
    $("#message").hidden = false;
    setMessage(`无法打开下载目录：${error.message}`, true);
  }
});

$("#select-all").addEventListener("click", () => {
  selectedIds = new Set(scannedItems.map((item) => item.id));
  document.querySelectorAll(".item-selector").forEach((checkbox) => { checkbox.checked = true; });
  updateSelection();
});

$("#clear-selection").addEventListener("click", () => {
  selectedIds.clear();
  document.querySelectorAll(".item-selector").forEach((checkbox) => { checkbox.checked = false; });
  updateSelection();
});

if (extensionApiAvailable) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "archive-progress") {
      if (Number.isFinite(message.percent)) {
        showDownloadProgress(message.text, message.percent);
      }
    }
  });
}

async function scanSearchPage(activeFilters, scanLimit) {
  const keyword = document.querySelector('[data-e2e="searchbar-input"]')?.value?.trim() || "抖音搜索";
  const itemsById = new Map();
  const collectCards = () => [...document.querySelectorAll('[id^="waterfall_item_"]')].forEach((card) => {
    const id = card.id.replace("waterfall_item_", "");
    const text = (card.innerText || "").trim();
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const type = text.includes("图文") ? "image" : "video";
    const authorLine = lines.find((line) => line.startsWith("@")) || "";
    const title = lines.find((line) => line.length > 8 && !line.startsWith("@") && !line.includes("图文")) || `抖音内容_${id}`;
    const dateText = lines.find((line) => /刚刚|分钟前|小时前|天前|月前|年|月\d+日/.test(line)) || "";
    const likes = Number((text.match(/(\d+(?:\.\d+)?)(万)?/) || [0, 0, ""])[1]) * ((text.match(/(\d+(?:\.\d+)?)(万)?/) || [0, 0, ""])[2] === "万" ? 10000 : 1);
    const cover = card.querySelector('img[src*="douyinpic"], img[src*="byteimg"]')?.currentSrc || "";
    if (/^\d+$/.test(id)) itemsById.set(id, { id, type, title, author: authorLine.replace(/^@/, ""), dateText, likes, cover });
  });
  const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const originalY = window.scrollY;
  let stalled = 0;
  while (itemsById.size < scanLimit && stalled < 4) {
    const previousCount = itemsById.size;
    collectCards();
    if (itemsById.size >= scanLimit) break;
    window.scrollBy({ top: Math.max(window.innerHeight, 720), behavior: "auto" });
    await waitFor(700);
    collectCards();
    stalled = itemsById.size > previousCount ? 0 : stalled + 1;
  }
  window.scrollTo({ top: originalY, behavior: "auto" });
  const items = [...itemsById.values()].slice(0, scanLimit);
  const format = activeFilters.format === "图文" ? "image" : activeFilters.format === "视频" ? "video" : null;
  const filtered = items.filter((item) => !format || item.type === format).filter((item) => matchesTime(item.dateText, activeFilters.time));
  return { keyword, scanned: items.length, items: filtered };

  function matchesTime(dateText, time) {
    if (time === "不限时间") return true;
    if (time === "一天内") return /刚刚|分钟前|小时前|今天/.test(dateText);
    if (time === "一周内") {
      const days = Number((dateText.match(/(\d+)天前/) || [0, 99])[1]);
      return /刚刚|分钟前|小时前|今天/.test(dateText) || days <= 7;
    }
    return !/20\d{2}年/.test(dateText) || dateText.startsWith(String(new Date().getFullYear()));
  }
}

async function applyFiltersToSearchPage(activeFilters) {
  const optionIndexes = {
    sort: { "综合排序": 0, "最新发布": 1, "最多点赞": 2 },
    time: { "不限时间": 0, "一天内": 1, "一周内": 2, "半年内": 3 },
    duration: { "不限时长": 0, "1分钟以下": 1, "1–5分钟": 2, "5分钟以上": 3 },
    scope: { "不限范围": 0, "关注的人": 1, "最近看过": 2, "还未看过": 3 },
    format: { "不限": 0, "视频": 1, "图文": 2 },
  };
  const groupIndexes = { sort: 0, time: 1, duration: 2, scope: 3, format: 4 };
  const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const getTrigger = () => [...document.querySelectorAll('[tabindex="0"]')].find((element) => element.innerText?.trim().startsWith("筛选"));
  const installNativePanelMask = () => {
    const styleId = "douyin-archive-native-filter-mask";
    document.getElementById(styleId)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = ".AZGfZJ4J,[data-douyin-archive-native-filter-panel=\"true\"]{display:none!important}";
    document.documentElement.append(style);
    const markPanel = () => {
      document.querySelectorAll("[data-index1][data-index2]").forEach((option) => {
        let panel = option.closest(".AZGfZJ4J");
        for (let parent = option.parentElement; !panel && parent && parent !== document.body; parent = parent.parentElement) {
          if (parent.querySelectorAll("[data-index1][data-index2]").length >= 12) panel = parent;
        }
        panel?.setAttribute("data-douyin-archive-native-filter-panel", "true");
      });
    };
    const observer = new MutationObserver(markPanel);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    markPanel();
    return () => {
      observer.disconnect();
      style.remove();
      document.querySelectorAll("[data-douyin-archive-native-filter-panel]").forEach((element) => element.removeAttribute("data-douyin-archive-native-filter-panel"));
    };
  };
  const openPanel = async () => {
    const trigger = getTrigger();
    if (!trigger) throw new Error("未找到抖音网页筛选入口");
    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }));
    await waitFor(120);
  };
  const closePanel = async () => {
    const trigger = getTrigger();
    if (!trigger) return;
    const propKey = Object.getOwnPropertyNames(trigger).find((key) => key.startsWith("__reactProps"));
    const props = propKey && trigger[propKey];
    if (props?.onMouseEnter && props?.onBlur) {
      props.onMouseEnter();
      await waitFor(80);
      props.onBlur();
      await waitFor(120);
      return;
    }
    trigger.focus();
    trigger.blur();
    await waitFor(120);
  };

  const removeNativePanelMask = installNativePanelMask();
  try {
    for (const [group, groupIndex] of Object.entries(groupIndexes)) {
      await openPanel();
      const optionIndex = optionIndexes[group][activeFilters[group]];
      const option = document.querySelector(`[data-index1="${groupIndex}"][data-index2="${optionIndex}"]`);
      if (!option) throw new Error(`网页中缺少「${activeFilters[group]}」筛选项`);
      const changed = !option.className.includes("sDNqBVWH");
      if (changed) option.click();
      await waitFor(changed ? 700 : 80);
    }
    await openPanel();
    const mismatched = Object.entries(groupIndexes).filter(([group, groupIndex]) => {
      const optionIndex = optionIndexes[group][activeFilters[group]];
      return !document.querySelector(`[data-index1="${groupIndex}"][data-index2="${optionIndex}"].sDNqBVWH`);
    });
    if (mismatched.length) throw new Error("网页未接受全部筛选条件");
    return { synced: true };
  } catch (error) {
    return { synced: false, error: error.message };
  } finally {
    await closePanel();
    removeNativePanelMask();
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
