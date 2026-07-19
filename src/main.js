const { app, BrowserWindow, dialog, ipcMain, net, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const sevenBin = require('7zip-bin');
const unrar = require('node-unrar-js');
const { ElectronDownloadManager } = require('electron-dl-manager');

const MAX_REDIRECTS = 8;
const AUTO_RESOLVER_MAX_STEPS = 12;
const AUTO_RESOLVER_STEP_DELAY = 1800;
const ARCHIVE_RE = /\.(zip|rar|7z)$/i;
const DOWNLOAD_URL_RE = /\.(zip|rar|7z|exe|msi|dmg|pkg|iso|apk|pdf|mp4|mkv|avi|mov|mp3|flac|wav)(?:$|[?&=])/i;
const MULTIPART_RAR_RE = /\.part(\d+)\.rar$/i;
const SYSTEM_EXTRACTOR_CANDIDATES = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '7-Zip', '7z.exe')
];
const SEVEN_ZIP_DOWNLOAD_URL = 'https://www.7-zip.org/download.html';
const RETRY_DELAY_MS = 3500;
const downloadManager = new ElectronDownloadManager();

class DownloadControlError extends Error {
  constructor(action, message) {
    super(message);
    this.action = action;
  }
}

let mainWindow;
let resolverWindows = new Set();
let resolverStates = new Map();
let resolverDownloadListenerInstalled = false;
let queue = [];
let batches = [];
let capturedLinks = [];
let activeDownloads = new Map();
let activeJobIds = new Set();
let nextId = 1;
let nextBatchId = 1;

let settings = {
  outputDir: path.join(app.getPath('downloads'), 'FFDownload'),
  concurrency: 4,
  deleteArchives: false,
  extractArchives: true,
  linkOnlyMode: false
};

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function statePath() {
  return path.join(app.getPath('userData'), 'ffdownload-state.json');
}

function persistStateSoon() {
  clearTimeout(persistStateSoon.timer);
  persistStateSoon.timer = setTimeout(() => {
    persistState().catch((error) => {
      console.error('Failed to persist state', error);
    });
  }, 250);
}

function sanitizeJobForClient(job) {
  if (!job || typeof job !== 'object') return job;
  const { browserItem, ...rest } = job;
  return rest;
}

function sanitizeStateForClient() {
  return {
    batches: batches.map((batch) => ({ ...batch })),
    queue: queue.map((job) => sanitizeJobForClient(job)),
    capturedLinks: capturedLinks.map((link) => ({ ...link })),
    settings: { ...settings }
  };
}

function serializeState() {
  return {
    stateVersion: 2,
    settings,
    batches,
    capturedLinks,
    queue: queue.map((job) => sanitizeJobForClient(job)),
    nextId,
    nextBatchId
  };
}

async function persistState() {
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await fsp.writeFile(statePath(), JSON.stringify(serializeState(), null, 2));
}

async function loadState() {
  try {
    const raw = await fsp.readFile(statePath(), 'utf8');
    const saved = JSON.parse(raw);
    const savedConcurrency = Number(saved.settings?.concurrency || settings.concurrency);
    const migratedConcurrency = !saved.stateVersion && savedConcurrency === 2 ? 4 : savedConcurrency;
    settings = {
      ...settings,
      ...(saved.settings || {}),
      concurrency: Math.max(1, Math.min(6, migratedConcurrency)),
      deleteArchives: Boolean(saved.settings?.deleteArchives),
      extractArchives: saved.settings?.extractArchives !== false,
      linkOnlyMode: Boolean(saved.settings?.linkOnlyMode)
    };
    batches = Array.isArray(saved.batches) ? saved.batches.map((batch) => ({
      ...batch,
      status: batch.status === 'extracting' ? 'queued' : batch.status,
      extracting: false
    })) : [];
    queue = Array.isArray(saved.queue) ? saved.queue.map((job) => {
      const shouldResume = ['downloading', 'extracting', 'retrying'].includes(job.status);
      return {
        ...job,
        status: shouldResume ? 'queued' : job.status,
        speed: 0,
        retryAt: null,
        message: shouldResume ? 'Resumed after restart' : job.message
      };
    }) : [];
    capturedLinks = Array.isArray(saved.capturedLinks) ? saved.capturedLinks : [];
    nextId = Number(saved.nextId || 1);
    nextBatchId = Number(saved.nextBatchId || 1);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load state', error);
  }
}

function sendState() {
  send('queue:changed', getQueueState());
}

function getQueueState() {
  return sanitizeStateForClient();
}

function sendCapturedLinks() {
  send('captured-links:changed', capturedLinks.map((link) => ({ ...link })));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f7f8fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    checkRequirementsOnLaunch();
  });
}

function createResolverWindow(url, options = {}) {
  const resolverWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    title: 'Link Resolver',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: 'persist:resolver',
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  installResolverDownloadListener(resolverWindow.webContents.session);
  installPopupBlocker(resolverWindow);

  resolverWindows.add(resolverWindow);
  resolverStates.set(resolverWindow, {
    auto: Boolean(options.auto),
    batchId: options.batchId || null,
    steps: 0,
    finished: false,
    initialUrl: url
  });

  resolverWindow.on('closed', () => {
    resolverWindows.delete(resolverWindow);
    resolverStates.delete(resolverWindow);
  });

  if (options.auto) {
    resolverWindow.webContents.on('did-finish-load', () => {
      scheduleAutoResolverStep(resolverWindow, 350);
    });
    resolverWindow.webContents.on('did-navigate', () => {
      scheduleAutoResolverStep(resolverWindow, 650);
    });
    resolverWindow.webContents.on('did-navigate-in-page', () => {
      scheduleAutoResolverStep(resolverWindow, 650);
    });
  }

  resolverWindow.loadURL(url);
  return resolverWindow;
}

function installPopupBlocker(resolverWindow) {
  resolverWindow.webContents.setWindowOpenHandler(({ url }) => {
    send('resolver:status', {
      type: 'blocked-popup',
      url,
      pageUrl: resolverWindow.webContents.getURL()
    });
    return { action: 'deny' };
  });
}

function installResolverDownloadListener(resolverSession) {
  if (resolverDownloadListenerInstalled) return;
  resolverDownloadListenerInstalled = true;

  resolverSession.on('will-download', (event, item, webContents) => {
    const batchId = resolverStates.get([...resolverWindows].find((win) => win.webContents.id === webContents.id))?.batchId;
    const sourceUrl = item.getURL();
    const filename = fileNameFromUrl(sourceUrl, item.getFilename());
    event.preventDefault();
    if (settings.linkOnlyMode) {
      addCapturedLink({
        sourceUrl,
        filename,
        pageUrl: webContents.getURL(),
        batchId
      });
      finishResolverForWebContents(webContents, 'link-captured');
      return;
    }

    addDownload({
      sourceUrl,
      pageUrl: webContents.getURL(),
      filename,
      expectedBytes: item.getTotalBytes() || 0,
      batchId
    });
    finishResolverForWebContents(webContents, 'download-started');
  });
}

function addCapturedLink(link) {
  if (!link?.sourceUrl) return;
  const normalized = normalizeUrl(link.sourceUrl);
  if (!normalized) return;
  if (capturedLinks.some((item) => item.sourceUrl === normalized)) {
    sendCapturedLinks();
    return;
  }

  capturedLinks.push({
    id: `${Date.now()}-${capturedLinks.length + 1}`,
    sourceUrl: normalized,
    filename: link.filename || fileNameFromUrl(normalized),
    pageUrl: link.pageUrl || '',
    batchId: link.batchId || null,
    capturedAt: Date.now()
  });
  persistStateSoon();
  sendCapturedLinks();
  send('resolver:status', {
    type: 'link-captured',
    url: normalized
  });
}

function finishResolverForWebContents(webContents, reason) {
  const resolverWindow = [...resolverWindows].find((win) => win.webContents.id === webContents.id);
  if (!resolverWindow) return;
  const state = resolverStates.get(resolverWindow);
  if (state) state.finished = true;
  send('resolver:status', {
    type: reason,
    url: webContents.getURL()
  });
  setTimeout(() => {
    if (!resolverWindow.isDestroyed()) resolverWindow.close();
  }, 250);
}

function startResolverBrowserDownload(resolverWindow, url) {
  if (!resolverWindow || resolverWindow.isDestroyed()) return false;
  resolverWindow.webContents.downloadURL(url);
  return true;
}

function scheduleAutoResolverStep(resolverWindow, delay = AUTO_RESOLVER_STEP_DELAY) {
  const state = resolverStates.get(resolverWindow);
  if (!state || !state.auto || state.finished || resolverWindow.isDestroyed()) return;

  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    runAutoResolverStep(resolverWindow);
  }, delay);
}

async function runAutoResolverStep(resolverWindow) {
  const state = resolverStates.get(resolverWindow);
  if (!state || !state.auto || state.finished || resolverWindow.isDestroyed()) return;

  const pageUrl = resolverWindow.webContents.getURL();
  if (looksLikeDownloadUrl(pageUrl)) {
    const started = startResolverBrowserDownload(resolverWindow, pageUrl);
    state.finished = true;
    send('resolver:status', { type: started ? 'direct-url' : 'error', url: pageUrl });
    setTimeout(() => {
      if (!resolverWindow.isDestroyed()) resolverWindow.close();
    }, 250);
    return;
  }

  if (state.steps >= AUTO_RESOLVER_MAX_STEPS) {
    state.finished = true;
    send('resolver:status', {
      type: 'stopped',
      url: pageUrl,
      message: 'Auto resolver stopped after too many clicks.'
    });
    return;
  }

  state.steps += 1;

  try {
    const result = await resolverWindow.webContents.executeJavaScript(autoResolverScript(), true);
    if (!result || result.action === 'none') {
      scheduleAutoResolverStep(resolverWindow);
      return;
    }

    send('resolver:status', {
      type: result.action,
      url: result.url || pageUrl,
      label: result.label || ''
    });

    if (result.action === 'clicked' && result.url) {
      state.finished = false;
      scheduleAutoResolverStep(resolverWindow, 1200);
      return;
    }

    scheduleAutoResolverStep(resolverWindow);
  } catch (error) {
    send('resolver:status', {
      type: 'error',
      url: pageUrl,
      message: error.message || 'Auto resolver failed.'
    });
    scheduleAutoResolverStep(resolverWindow);
  }
}

function autoResolverScript() {
  return `(() => {
    const downloadRe = ${DOWNLOAD_URL_RE};
    const comparableUrl = (raw) => {
      try {
        const parsed = new URL(raw, location.href);
        return parsed.pathname + parsed.search;
      } catch {
        return raw || '';
      }
    };
    const looksLikeDownloadUrl = (raw) => downloadRe.test(comparableUrl(raw));
    const positive = [
      /download/i,
      /download now/i,
      /free download/i,
      /create download/i,
      /generate link/i,
      /get link/i,
      /continue/i,
      /start/i,
      /resume/i,
      /save file/i
    ];
    const negative = [
      /advert/i,
      /sponsor/i,
      /popup/i,
      /login/i,
      /sign up/i,
      /register/i,
      /subscribe/i,
      /notification/i,
      /report/i,
      /dmca/i,
      /terms/i,
      /privacy/i,
      /facebook|twitter|telegram|discord|whatsapp/i
    ];

    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || 1) > 0.05 &&
        rect.width >= 24 &&
        rect.height >= 14;
    };

    const textFor = (el) => [
      el.innerText,
      el.textContent,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('value'),
      el.getAttribute('download'),
      el.href
    ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();

    const candidates = [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]')]
      .filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map((el) => {
        const text = textFor(el);
        const href = el.href || el.getAttribute('data-href') || el.getAttribute('data-url') || '';
        let score = 0;
        if (looksLikeDownloadUrl(href)) score += 120;
        if (el.hasAttribute('download')) score += 100;
        positive.forEach((re, index) => {
          if (re.test(text)) score += 55 - index;
        });
        negative.forEach((re) => {
          if (re.test(text)) score -= 70;
        });
        const rect = el.getBoundingClientRect();
        if (rect.top >= 0 && rect.top <= window.innerHeight) score += 12;
        if (rect.width > 110 && rect.height > 28) score += 8;
        return { el, text, href, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const preferred = candidates.find((item) => item.href && looksLikeDownloadUrl(item.href));
    if (preferred) {
      preferred.el.scrollIntoView({ block: 'center', inline: 'center' });
      preferred.el.click();
      return {
        action: 'clicked',
        url: new URL(preferred.href, location.href).toString(),
        label: preferred.text,
        filename: preferred.el.getAttribute('download') || ''
      };
    }

    const best = candidates[0];
    if (!best) {
      window.scrollBy({ top: Math.round(window.innerHeight * 0.7), behavior: 'instant' });
      return { action: 'none' };
    }

    best.el.scrollIntoView({ block: 'center', inline: 'center' });
    best.el.click();
    return { action: 'clicked', label: best.text, url: best.href || location.href };
  })()`;
}

async function checkRequirementsOnLaunch() {
  const requirements = getRequirementStatus();
  send('requirements:checked', requirements);

  if (requirements.fullSevenZip.available) return;

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Download 7-Zip', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: '7-Zip Recommended',
    message: 'Install full 7-Zip for multipart RAR extraction',
    detail: 'ZIP, 7Z, and normal RAR extraction can still work. Files like .part001.rar need full 7-Zip installed.'
  });

  if (result.response === 0) {
    await shell.openExternal(SEVEN_ZIP_DOWNLOAD_URL);
  }
}

function getRequirementStatus() {
  const systemExtractor = findSystemExtractor();
  return {
    fullSevenZip: {
      available: Boolean(systemExtractor),
      path: systemExtractor || null,
      downloadUrl: SEVEN_ZIP_DOWNLOAD_URL
    },
    bundledZipExtractor: {
      available: fs.existsSync(sevenBin.path7za),
      path: sevenBin.path7za
    },
    normalRarExtractor: {
      available: Boolean(unrar && unrar.createExtractorFromFile)
    }
  };
}

function normalizeUrl(raw) {
  try {
    return new URL(raw.trim()).toString();
  } catch {
    return null;
  }
}

function downloadComparableUrl(raw) {
  try {
    const parsed = new URL(raw);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return raw;
  }
}

function looksLikeDownloadUrl(raw) {
  return DOWNLOAD_URL_RE.test(downloadComparableUrl(raw));
}

function fileNameFromUrl(url, fallback) {
  if (fallback) return sanitizeFilename(fallback);
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(path.basename(parsed.pathname));
    return sanitizeFilename(last || `download-${Date.now()}`);
  } catch {
    return sanitizeFilename(`download-${Date.now()}`);
  }
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 220);
}

function batchNameFromLinks(links) {
  const names = links.map((link) => fileNameHintFromUrl(link)).filter(Boolean);
  const first = names[0] || `Batch ${nextBatchId}`;
  const base = first
    .replace(/\.part\d+\.rar$/i, '')
    .replace(/\.(zip|rar|7z|exe|msi|dmg|pkg|iso|apk|pdf|mp4|mkv|avi|mov|mp3|flac|wav)$/i, '');
  return sanitizeFilename(base || first || `Batch ${nextBatchId}`);
}

function fileNameHintFromUrl(raw) {
  try {
    const parsed = new URL(raw);
    const hashName = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : '';
    const pathName = decodeURIComponent(path.basename(parsed.pathname));
    return sanitizeFilename(hashName || pathName || '');
  } catch {
    return '';
  }
}

function createBatch(links, mode) {
  const id = nextBatchId++;
  const name = uniqueBatchName(batchNameFromLinks(links));
  const folder = path.join(settings.outputDir, name);
  const batch = {
    id,
    name,
    folder,
    mode,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    status: 'queued',
    linkCount: links.length
  };
  batches.unshift(batch);
  persistStateSoon();
  sendState();
  return batch;
}

function uniqueBatchName(name) {
  let candidate = name || `Batch ${nextBatchId}`;
  let suffix = 2;
  const existing = new Set(batches.map((batch) => batch.name.toLowerCase()));
  while (existing.has(candidate.toLowerCase()) || fs.existsSync(path.join(settings.outputDir, candidate))) {
    candidate = `${name} (${suffix})`;
    suffix += 1;
  }
  return candidate;
}

function getBatch(batchId) {
  return batches.find((batch) => batch.id === batchId) || null;
}

function updateBatch(batchId, patch) {
  batches = batches.map((batch) => (batch.id === batchId ? { ...batch, ...patch } : batch));
  persistStateSoon();
  sendState();
}

function refreshBatchStatus(batchId) {
  const batch = getBatch(batchId);
  if (!batch) return;
  const jobs = queue.filter((job) => job.batchId === batchId);
  if (!jobs.length) return;

  const hasActive = jobs.some((job) => ['queued', 'downloading', 'extracting', 'retrying'].includes(job.status));
  const hasError = jobs.some((job) => job.status === 'error');
  const allDone = jobs.every((job) => job.status === 'done');
  const allPaused = jobs.every((job) => job.status === 'paused');
  const allCanceled = jobs.every((job) => job.status === 'canceled');
  const startedAt = batch.startedAt || Math.min(...jobs.map((job) => job.startedAt || Date.now()));

  if (allDone) {
    updateBatch(batchId, { status: 'done', startedAt, completedAt: batch.completedAt || Date.now() });
  } else if (allPaused) {
    updateBatch(batchId, { status: 'paused', startedAt, completedAt: null });
  } else if (allCanceled) {
    updateBatch(batchId, { status: 'canceled', startedAt, completedAt: null });
  } else if (hasActive) {
    updateBatch(batchId, { status: 'downloading', startedAt, completedAt: null });
  } else if (hasError) {
    updateBatch(batchId, { status: 'error', startedAt, completedAt: null });
  }
}

function addDownload(download) {
  const sourceUrl = normalizeUrl(download.sourceUrl);
  if (!sourceUrl) return;

  const filename = fileNameFromUrl(sourceUrl, download.filename);
  const batch = getBatch(download.batchId) || createBatch([sourceUrl], 'captured');
  const destination = uniqueDestination(batch.folder, filename);
  const id = nextId++;
  const job = {
    id,
    batchId: batch.id,
    sourceUrl,
    pageUrl: download.pageUrl || sourceUrl,
    filename,
    destination,
    status: 'queued',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: Number(download.totalBytes || download.expectedBytes || 0),
    expectedBytes: Number(download.expectedBytes || download.totalBytes || 0),
    speed: 0,
    averageSpeed: 0,
    startedAt: null,
    completedAt: null,
    retryCount: 0,
    retryAt: null,
    message: 'Queued',
    windowId: download.windowId || null,
    managerDownloadId: null
  };

  queue.push(job);
  updateBatch(batch.id, { status: 'queued', completedAt: null });
  persistStateSoon();
  sendState();
  pumpQueue();
}

function uniqueDestination(dir, filename) {
  let candidate = path.join(dir, filename);
  const parsed = path.parse(filename);
  let suffix = 2;

  while (
    queue.some((job) => job.destination.toLowerCase() === candidate.toLowerCase()) ||
    fs.existsSync(candidate) ||
    fs.existsSync(`${candidate}.part`)
  ) {
    candidate = path.join(dir, `${parsed.name} (${suffix})${parsed.ext}`);
    suffix += 1;
  }

  return candidate;
}

function updateJob(id, patch) {
  queue = queue.map((job) => (job.id === id ? { ...job, ...patch } : job));
  const updated = queue.find((job) => job.id === id);
  if (updated?.batchId) refreshBatchStatus(updated.batchId);
  persistStateSoon();
  sendState();
}

function pumpQueue() {
  while (activeJobIds.size < settings.concurrency) {
    const job = queue.find((item) => item.status === 'queued' && !activeJobIds.has(item.id));
    if (!job) break;
    activeJobIds.add(job.id);
    runJob(job).finally(() => {
      activeJobIds.delete(job.id);
      pumpQueue();
    });
  }
}

async function runJob(job) {
  try {
    const current = queue.find((item) => item.id === job.id) || job;
    if (!current || current.status === 'paused' || current.status === 'canceled') return;
    await fsp.mkdir(path.dirname(current.destination), { recursive: true });
    updateJob(job.id, {
      status: 'downloading',
      message: current.retryCount ? `Retry ${current.retryCount}: downloading` : 'Downloading',
      startedAt: current.startedAt || Date.now(),
      retryAt: null
    });

    try {
      await startManagedDownload(current);
    } catch (error) {
      if (error instanceof DownloadControlError) {
        updateJob(current.id, {
          status: error.action,
          speed: 0,
          retryAt: null,
          message: error.message
        });
        return;
      }
      scheduleRetry(current, error);
      return;
    }

    if (settings.extractArchives && ARCHIVE_RE.test(current.destination) && !MULTIPART_RAR_RE.test(current.destination)) {
      updateJob(current.id, { status: 'extracting', message: 'Extracting archive' });
      await extractArchive(current.destination, path.dirname(current.destination));
      if (settings.deleteArchives) {
        await deleteArchiveSet(current.destination);
      }
    }

    updateJob(current.id, { status: 'done', progress: 100, speed: 0, retryAt: null, completedAt: Date.now(), message: 'Complete' });
    maybeExtractCompletedBatch(current.batchId);
  } catch (error) {
    updateJob(job.id, {
      status: 'error',
      speed: 0,
      retryAt: null,
      message: error.message || 'Download failed'
    });
  }
}

function maybeExtractCompletedBatch(batchId) {
  const batch = getBatch(batchId);
  if (!batch || batch.extracting || batch.extractedAt || !settings.extractArchives) return;

  const jobs = queue.filter((item) => item.batchId === batchId);
  if (!jobs.length || !jobs.every((item) => item.status === 'done')) return;

  const multipartFirst = jobs.find((item) => {
    const match = MULTIPART_RAR_RE.exec(item.destination);
    return match && Number(match[1]) === 1;
  });
  if (!multipartFirst) return;

  updateBatch(batchId, { status: 'extracting', extracting: true, completedAt: null });
  extractArchive(multipartFirst.destination, batch.folder)
    .then(async () => {
      if (settings.deleteArchives) await deleteArchiveSet(multipartFirst.destination);
      updateBatch(batchId, { status: 'done', extracting: false, extractedAt: Date.now(), completedAt: Date.now() });
    })
    .catch((error) => {
      updateBatch(batchId, {
        status: 'error',
        extracting: false,
        extractionError: error.message || 'Batch extraction failed'
      });
    });
}

function scheduleRetry(job, error) {
  const retryAt = Date.now() + RETRY_DELAY_MS;
  updateJob(job.id, {
    status: 'retrying',
    speed: 0,
    retryAt,
    retryCount: Number(job.retryCount || 0) + 1,
    message: `${error.message || 'Download failed'}; retrying in ${Math.round(RETRY_DELAY_MS / 1000)}s`
  });

  setTimeout(() => {
    const latest = queue.find((item) => item.id === job.id);
    if (!latest || latest.status !== 'retrying') return;
    updateJob(job.id, {
      status: 'queued',
      retryAt: null,
      message: 'Retry queued'
    });
    pumpQueue();
  }, RETRY_DELAY_MS);
}

function updateDownloadMetrics(active, bytes) {
  if (!active) return { speed: 0, averageSpeed: 0 };

  const now = Date.now();
  const startedAt = active.startedAt || now;
  const elapsedSeconds = Math.max(1, (now - startedAt) / 1000);
  const intervalSeconds = Math.max(0.001, (now - (active.lastTime || now)) / 1000);
  const intervalBytes = Math.max(0, bytes - Number(active.lastBytes || 0));
  const instantSpeed = intervalBytes / intervalSeconds;

  active.smoothedSpeed = active.smoothedSpeed
    ? (active.smoothedSpeed * 0.82) + (instantSpeed * 0.18)
    : instantSpeed;
  active.lastBytes = bytes;
  active.lastTime = now;

  return {
    speed: active.smoothedSpeed,
    averageSpeed: bytes / elapsedSeconds
  };
}

function getWindowForJob(job) {
  if (!job?.windowId) return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const window = BrowserWindow.fromId(job.windowId);
  return window && !window.isDestroyed() ? window : null;
}

async function startManagedDownload(job) {
  const targetWindow = getWindowForJob(job);
  if (!targetWindow) {
    throw new Error('No browser window available for the download.');
  }

  return new Promise((resolve, reject) => {
    const active = {
      action: null,
      startedAt: job.startedAt || Date.now(),
      lastBytes: Number(job.downloadedBytes || 0),
      lastTime: Date.now(),
      smoothedSpeed: Number(job.speed || 0)
    };
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const isStoppedByControl = () => {
      const latest = queue.find((item) => item.id === job.id);
      return !latest || ['paused', 'canceled', 'done', 'error'].includes(latest.status);
    };
    const normalizeDestroyedError = (error) => {
      if (!error || typeof error.message !== 'string') return error;
      if (error.message.includes('used after being destroyed') || error.message.includes('download item')) {
        return new DownloadControlError('canceled', 'Canceled');
      }
      return error;
    };

    downloadManager.download({
      window: targetWindow,
      url: job.sourceUrl,
      directory: path.dirname(job.destination),
      saveAsFilename: path.basename(job.destination),
      callbacks: {
        onDownloadStarted: ({ id }) => {
          if (isStoppedByControl()) return;
          activeDownloads.set(job.id, active);
          updateJob(job.id, {
            managerDownloadId: id,
            status: 'downloading',
            message: 'Downloading',
            startedAt: job.startedAt || Date.now(),
            retryAt: null
          });
        },
        onDownloadProgress: ({ item }) => {
          if (isStoppedByControl()) return;
          try {
            const received = item.getReceivedBytes();
            const total = item.getTotalBytes() || 0;
            const metrics = updateDownloadMetrics(active, received);
            updateJob(job.id, {
              downloadedBytes: received,
              totalBytes: total,
              expectedBytes: total,
              progress: total ? Math.round((received / total) * 100) : 0,
              speed: metrics.speed,
              averageSpeed: metrics.averageSpeed,
              message: 'Downloading'
            });
          } catch (error) {
            const normalized = normalizeDestroyedError(error);
            if (normalized instanceof DownloadControlError) {
              finish(reject, normalized);
            }
          }
        },
        onDownloadCompleted: () => {
          if (isStoppedByControl()) return;
          updateJob(job.id, {
            progress: 100,
            speed: 0,
            retryAt: null,
            completedAt: Date.now(),
            message: 'Complete'
          });
          finish(resolve, undefined);
        },
        onDownloadCancelled: () => {
          if (isStoppedByControl()) return;
          finish(reject, new DownloadControlError('canceled', 'Canceled'));
        },
        onDownloadInterrupted: () => {
          if (isStoppedByControl()) return;
          finish(reject, new DownloadControlError('canceled', 'Canceled'));
        },
        onError: (error) => {
          const normalized = normalizeDestroyedError(error);
          if (isStoppedByControl()) return;
          finish(reject, normalized);
        }
      }
    }).catch((error) => {
      finish(reject, normalizeDestroyedError(error));
    }).finally(() => {
      if (activeDownloads.get(job.id) === active) activeDownloads.delete(job.id);
    });
  });
}

async function downloadToFile(job) {
  const headers = await browserHeadersFor(job.sourceUrl, job.pageUrl);
  await requestToFile(job.sourceUrl, job.destination, headers, job.id);
}

async function browserHeadersFor(sourceUrl, pageUrl) {
  const resolverSession = session.fromPartition('persist:resolver');
  const cookies = await resolverSession.cookies.get({ url: sourceUrl });
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const openResolver = [...resolverWindows].find((win) => !win.isDestroyed());
  const userAgent = openResolver
    ? openResolver.webContents.getUserAgent()
    : session.defaultSession.getUserAgent();

  return {
    'User-Agent': userAgent,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(pageUrl ? { Referer: pageUrl } : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {})
  };
}

async function requestToFile(url, destination, headers, jobId, redirects = 0) {
  const tempPath = `${destination}.part`;
  const partialStats = await fsp.stat(tempPath).catch(() => null);
  const resumeBytes = partialStats?.size || 0;
  const requestHeaders = resumeBytes
    ? { ...headers, Range: `bytes=${resumeBytes}-` }
    : headers;

  return new Promise((resolve, reject) => {
    const active = { request: null, file: null, action: null, redirects: 0 };
    activeDownloads.set(jobId, active);
    let timeout = null;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (activeDownloads.get(jobId) === active) activeDownloads.delete(jobId);
      callback(value);
    };
    const request = net.request({
      url,
      session: session.fromPartition('persist:resolver'),
      useSessionCookies: true
    });
    Object.entries(requestHeaders).forEach(([name, value]) => {
      request.setHeader(name, String(value));
    });
    timeout = setTimeout(() => {
      settle(reject, new Error('Download timed out'));
      request.abort();
    }, 120000);

    request.on('response', async (response) => {
      active.request = request;
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          settle(reject, new Error('Too many redirects'));
          return;
        }
        const location = response.headers.location;
        if (!location) {
          settle(reject, new Error('Redirect without location header'));
          return;
        }
        const redirectUrl = new URL(location, url).toString();
        requestToFile(redirectUrl, destination, headers, jobId, redirects + 1).then(
          (value) => settle(resolve, value),
          (error) => settle(reject, error)
        );
        return;
      }

      if (resumeBytes && response.statusCode === 416) {
        response.resume();
        const tempStats = await fsp.stat(tempPath).catch(() => null);
        if (tempStats) {
          await fsp.rename(tempPath, destination);
          settle(resolve);
          return;
        }
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        settle(reject, new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      const contentDisposition = String(response.headers['content-disposition'] || '').toLowerCase();
      if (contentType.includes('text/html') && !contentDisposition.includes('attachment')) {
        response.resume();
        settle(reject, new Error('Server returned a webpage instead of a file. Try Auto Resolve or click the page download button again.'));
        return;
      }

      const acceptedRange = response.statusCode === 206 && resumeBytes > 0;
      const contentRange = String(response.headers['content-range'] || '');
      const rangeTotal = Number((contentRange.match(/\/(\d+)$/) || [])[1] || 0);
      const total = rangeTotal || Number(response.headers['content-length'] || 0) + (acceptedRange ? resumeBytes : 0);
      if (resumeBytes && !acceptedRange) {
        updateJob(jobId, { downloadedBytes: 0, progress: 0, message: 'Server did not support resume; restarting file' });
        await fsp.rm(tempPath, { force: true }).catch(() => {});
      }
      const file = fs.createWriteStream(tempPath, { flags: acceptedRange ? 'a' : 'w' });
      active.file = file;
      let downloaded = acceptedRange ? resumeBytes : 0;
      let lastBytes = downloaded;
      let lastTime = Date.now();
      const startedAt = Date.now();
      let smoothedSpeed = 0;
      let streamError = null;

      if (acceptedRange) {
        updateJob(jobId, {
          downloadedBytes: downloaded,
          totalBytes: total,
          expectedBytes: total,
          progress: total ? Math.round((downloaded / total) * 100) : 0,
          message: `Resumed at ${formatBytesForMessage(downloaded)}`
        });
      }

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastTime >= 1000) {
          const speed = ((downloaded - lastBytes) / ((now - lastTime) / 1000));
          smoothedSpeed = smoothedSpeed ? (smoothedSpeed * 0.82) + (speed * 0.18) : speed;
          const averageSpeed = downloaded / Math.max(1, (now - startedAt) / 1000);
          updateJob(jobId, {
            downloadedBytes: downloaded,
            totalBytes: total,
            expectedBytes: total,
            progress: total ? Math.round((downloaded / total) * 100) : 0,
            speed: smoothedSpeed,
            averageSpeed,
            message: 'Downloading'
          });
          lastBytes = downloaded;
          lastTime = now;
        }
      });

      response.on('aborted', () => {
        streamError = active.action
          ? new DownloadControlError(active.action, active.action === 'paused' ? 'Paused' : 'Canceled')
          : new Error('Download was interrupted before the file finished.');
        file.destroy(streamError);
      });
      response.on('error', (error) => {
        streamError = active.action
          ? new DownloadControlError(active.action, active.action === 'paused' ? 'Paused' : 'Canceled')
          : error;
        file.destroy(error);
      });

      response.pipe(file);
      file.on('error', (error) => {
        streamError = active.action
          ? new DownloadControlError(active.action, active.action === 'paused' ? 'Paused' : 'Canceled')
          : error;
      });
      file.on('close', async () => {
        if (streamError) {
          settle(reject, streamError);
          return;
        }

        try {
          if (total && downloaded < total) {
            throw new Error(`Download incomplete: ${formatBytesForMessage(downloaded)} of ${formatBytesForMessage(total)} received.`);
          }

          const tempStats = await fsp.stat(tempPath).catch(() => null);
          if (!tempStats) {
            throw new Error(`Temporary download file disappeared before it could be saved: ${tempPath}`);
          }

          await fsp.rename(tempPath, destination);
          updateJob(jobId, {
            downloadedBytes: downloaded,
            totalBytes: total,
            expectedBytes: total,
            progress: 100,
            speed: 0,
            averageSpeed: downloaded / Math.max(1, (Date.now() - startedAt) / 1000)
          });
          settle(resolve);
        } catch (error) {
          settle(reject, error);
        }
      });
    });

    active.request = request;
    request.on('error', (error) => {
      clearTimeout(timeout);
      if (active.action) {
        settle(reject, new DownloadControlError(active.action, active.action === 'paused' ? 'Paused' : 'Canceled'));
        return;
      }
      settle(reject, error);
    });
    request.on('redirect', (statusCode, method, redirectUrl) => {
      active.redirects += 1;
      if (active.redirects > MAX_REDIRECTS) {
        settle(reject, new Error('Too many redirects'));
        request.abort();
        return;
      }
      request.followRedirect();
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    request.end();
  });
}

function formatBytesForMessage(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function stopActiveJob(jobId, action) {
  const active = activeDownloads.get(jobId);
  if (!active) return false;
  active.action = action;
  const error = new DownloadControlError(action, action === 'paused' ? 'Paused' : 'Canceled');
  let stopped = false;

  if (active.item && action === 'paused' && active.item.pause) {
    active.item.pause();
    stopped = true;
  } else if (active.item && active.item.cancel) {
    active.item.cancel();
    stopped = true;
  }

  if (active.request?.destroy) {
    active.request.destroy(error);
    stopped = true;
  } else if (active.request?.abort) {
    active.request.abort();
    stopped = true;
  }

  if (active.file) {
    active.file.destroy(error);
    stopped = true;
  }

  return stopped;
}

function stopManagedJob(job, action) {
  if (!job?.managerDownloadId) return false;
  if (action === 'paused') {
    downloadManager.pauseDownload(job.managerDownloadId);
  } else {
    downloadManager.cancelDownload(job.managerDownloadId);
  }
  return true;
}

async function pauseJob(jobId) {
  const job = queue.find((item) => item.id === jobId);
  if (!job || ['done', 'canceled'].includes(job.status)) return getQueueState();
  if (job.status === 'queued' || job.status === 'retrying') {
    updateJob(jobId, { status: 'paused', speed: 0, retryAt: null, message: 'Paused' });
    return getQueueState();
  }
  const stopped = stopActiveJob(jobId, 'paused');
  if (!stopped) stopManagedJob(job, 'paused');
  updateJob(jobId, { status: 'paused', speed: 0, retryAt: null, message: 'Paused' });
  return getQueueState();
}

async function resumeJob(jobId) {
  const job = queue.find((item) => item.id === jobId);
  if (!job || job.status !== 'paused') return getQueueState();
  const active = activeDownloads.get(jobId);
  if (active?.item?.canResume?.()) {
    active.item.resume();
    updateJob(jobId, { status: 'downloading', retryAt: null, message: 'Downloading' });
    return getQueueState();
  }
  if (job.managerDownloadId) {
    downloadManager.resumeDownload(job.managerDownloadId);
  }
  updateJob(jobId, { status: 'queued', retryAt: null, message: 'Resume queued' });
  pumpQueue();
  return getQueueState();
}

async function cancelJob(jobId) {
  const job = queue.find((item) => item.id === jobId);
  if (!job || job.status === 'done') return getQueueState();
  const stopped = stopActiveJob(jobId, 'canceled');
  if (!stopped) stopManagedJob(job, 'canceled');
  await fsp.rm(`${job.destination}.part`, { force: true }).catch(() => {});
  updateJob(jobId, { status: 'canceled', speed: 0, retryAt: null, message: 'Canceled' });
  return getQueueState();
}

async function deleteJob(jobId) {
  const job = queue.find((item) => item.id === jobId);
  if (!job) return getQueueState();
  const stopped = stopActiveJob(jobId, 'canceled');
  if (!stopped) stopManagedJob(job, 'canceled');
  await Promise.all([
    fsp.rm(job.destination, { force: true }).catch(() => {}),
    fsp.rm(`${job.destination}.part`, { force: true }).catch(() => {})
  ]);
  queue = queue.filter((item) => item.id !== jobId);
  const batchHasJobs = queue.some((item) => item.batchId === job.batchId);
  if (!batchHasJobs) {
    batches = batches.filter((batch) => batch.id !== job.batchId);
  } else if (job.batchId) {
    refreshBatchStatus(job.batchId);
  }
  persistStateSoon();
  sendState();
  pumpQueue();
  return getQueueState();
}

function jobsForBatch(batchId) {
  return queue.filter((job) => job.batchId === batchId || (!job.batchId && batchId === 0));
}

async function pauseBatch(batchId) {
  const jobs = jobsForBatch(batchId);
  for (const job of jobs) {
    if (['queued', 'downloading', 'retrying'].includes(job.status)) {
      await pauseJob(job.id);
    }
  }
  refreshBatchStatus(batchId);
  return getQueueState();
}

async function resumeBatch(batchId) {
  const jobs = jobsForBatch(batchId);
  for (const job of jobs) {
    if (job.status === 'paused') {
      await resumeJob(job.id);
    }
  }
  refreshBatchStatus(batchId);
  pumpQueue();
  return getQueueState();
}

async function cancelBatch(batchId) {
  const jobs = jobsForBatch(batchId);
  for (const job of jobs) {
    if (!['done', 'canceled'].includes(job.status)) {
      await cancelJob(job.id);
    }
  }
  refreshBatchStatus(batchId);
  return getQueueState();
}

async function deleteBatch(batchId) {
  const jobs = jobsForBatch(batchId);
  for (const job of jobs) {
    await deleteJob(job.id);
  }
  batches = batches.filter((batch) => batch.id !== batchId);
  persistStateSoon();
  sendState();
  pumpQueue();
  return getQueueState();
}

function extractArchive(archivePath, outputDir) {
  if (/\.rar$/i.test(archivePath)) {
    return extractRar(archivePath, outputDir);
  }

  const extractDir = path.join(outputDir, path.basename(archivePath).replace(ARCHIVE_RE, ''));
  return runSevenZip(sevenBin.path7za, archivePath, extractDir);
}

async function extractRar(archivePath, outputDir) {
  const isPart = MULTIPART_RAR_RE.exec(archivePath);
  if (isPart && Number(isPart[1]) !== 1) return;

  const systemExtractor = findSystemExtractor();
  if (systemExtractor) {
    const extractDir = path.join(outputDir, path.basename(archivePath).replace(ARCHIVE_RE, ''));
    await runSevenZip(systemExtractor, archivePath, extractDir);
    return;
  }

  if (isPart) {
    throw new Error('Multipart RAR extraction needs a full 7-Zip install; downloaded files were kept.');
  }

  const extractDir = path.join(outputDir, path.basename(archivePath).replace(ARCHIVE_RE, ''));
  await fsp.mkdir(extractDir, { recursive: true });
  const extractor = await unrar.createExtractorFromFile({
    filepath: archivePath,
    targetPath: extractDir
  });
  const result = extractor.extract();
  [...result.files];
}

function runSevenZip(executable, archivePath, extractDir) {
  return new Promise((resolve, reject) => {
    fsp.mkdir(extractDir, { recursive: true }).then(() => {
      const child = spawn(executable, ['x', archivePath, `-o${extractDir}`, '-y', '-bsp1'], {
        windowsHide: true
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `7-Zip exited with code ${code}`));
      });
    }).catch(reject);
  });
}

function findSystemExtractor() {
  return SYSTEM_EXTRACTOR_CANDIDATES.find((candidate) => {
    if (candidate.includes(path.sep)) return fs.existsSync(candidate);
    return false;
  });
}

async function deleteArchiveSet(archivePath) {
  const partMatch = MULTIPART_RAR_RE.exec(archivePath);
  if (!partMatch) {
    await fsp.rm(archivePath, { force: true });
    return;
  }

  const dir = path.dirname(archivePath);
  const base = path.basename(archivePath).replace(/\.part\d+\.rar$/i, '');
  const files = await fsp.readdir(dir);
  await Promise.all(files
    .filter((file) => file.toLowerCase().startsWith(base.toLowerCase()) && MULTIPART_RAR_RE.test(file))
    .map((file) => fsp.rm(path.join(dir, file), { force: true })));
}

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:update', (_event, nextSettings) => {
  settings = {
    ...settings,
    ...nextSettings,
    concurrency: Math.max(1, Math.min(6, Number(nextSettings.concurrency || settings.concurrency))),
    deleteArchives: Boolean(nextSettings.deleteArchives),
    extractArchives: Boolean(nextSettings.extractArchives),
    linkOnlyMode: Boolean(nextSettings.linkOnlyMode)
  };
  persistStateSoon();
  pumpQueue();
  return settings;
});

ipcMain.handle('dialog:outputDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose download folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return settings.outputDir;
  settings.outputDir = result.filePaths[0];
  persistStateSoon();
  return settings.outputDir;
});

ipcMain.handle('links:openForResolution', async (_event, rawLinks) => {
  const links = rawLinks.map(normalizeUrl).filter(Boolean);
  if (!links.length) return 0;
  const batch = createBatch(links, 'browser');
  links.forEach((link) => createResolverWindow(link, { batchId: batch.id }));
  return links.length;
});

ipcMain.handle('links:autoResolve', async (_event, rawLinks) => {
  const links = rawLinks.map(normalizeUrl).filter(Boolean);
  if (!links.length) return 0;
  const batch = createBatch(links, 'auto');
  links.forEach((link) => createResolverWindow(link, { auto: true, batchId: batch.id }));
  return links.length;
});

ipcMain.handle('downloads:addDirect', (_event, rawLinks) => {
  const links = rawLinks.map(normalizeUrl).filter(Boolean);
  if (!links.length) return 0;
  const batch = createBatch(links, 'direct');
  links.forEach((sourceUrl) => addDownload({ sourceUrl, batchId: batch.id }));
  return links.length;
});

ipcMain.handle('queue:get', () => getQueueState());
ipcMain.handle('captured-links:get', () => capturedLinks.map((link) => ({ ...link })));
ipcMain.handle('captured-links:clear', () => {
  capturedLinks = [];
  persistStateSoon();
  sendCapturedLinks();
  return [];
});
ipcMain.handle('job:pause', (_event, jobId) => pauseJob(Number(jobId)));
ipcMain.handle('job:resume', (_event, jobId) => resumeJob(Number(jobId)));
ipcMain.handle('job:cancel', (_event, jobId) => cancelJob(Number(jobId)));
ipcMain.handle('job:delete', (_event, jobId) => deleteJob(Number(jobId)));
ipcMain.handle('batch:pause', (_event, batchId) => pauseBatch(Number(batchId)));
ipcMain.handle('batch:resume', (_event, batchId) => resumeBatch(Number(batchId)));
ipcMain.handle('batch:cancel', (_event, batchId) => cancelBatch(Number(batchId)));
ipcMain.handle('batch:delete', (_event, batchId) => deleteBatch(Number(batchId)));
ipcMain.handle('requirements:get', () => getRequirementStatus());
ipcMain.handle('folder:open', async (_event, folderPath) => {
  const normalized = path.resolve(folderPath);
  const outputRoot = path.resolve(settings.outputDir);
  const normalizedLower = normalized.toLowerCase();
  const outputRootLower = outputRoot.toLowerCase();
  if (normalizedLower !== outputRootLower && !normalizedLower.startsWith(`${outputRootLower}${path.sep}`)) {
    throw new Error('Can only open folders inside the download folder.');
  }
  await fsp.mkdir(normalized, { recursive: true });
  await shell.openPath(normalized);
});

app.whenReady().then(async () => {
  await loadState();
  createMainWindow();
  pumpQueue();
  batches.forEach((batch) => maybeExtractCompletedBatch(batch.id));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  persistState().catch(() => {});
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
