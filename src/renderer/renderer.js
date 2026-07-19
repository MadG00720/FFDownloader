const linksEl = document.querySelector('#links');
const queueEl = document.querySelector('#queue');
const queueSummaryEl = document.querySelector('#queueSummary');
const queueStatsEl = document.querySelector('#queueStats');
const outputDirEl = document.querySelector('#outputDir');
const requirementsEl = document.querySelector('#requirements');
const resolverStatusEl = document.querySelector('#resolverStatus');
const toggleLinkOnlyEl = document.querySelector('#toggleLinkOnly');
const linkPadEl = document.querySelector('#linkPad');
const linkPadCountEl = document.querySelector('#linkPadCount');
const capturedLinksTextEl = document.querySelector('#capturedLinksText');
const concurrencyEl = document.querySelector('#concurrency');
const extractArchivesEl = document.querySelector('#extractArchives');
const deleteArchivesEl = document.querySelector('#deleteArchives');

let settings = {};
let latestQueueState = { batches: [], queue: [] };
let capturedLinks = [];

function parseLinks() {
  return linksEl.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  const rounded = Math.ceil(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;

  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function normalizeState(state) {
  if (Array.isArray(state)) {
    return { batches: [{ id: 0, name: 'Downloads', status: 'downloading', createdAt: Date.now(), folder: '' }], queue: state };
  }
  return {
    batches: Array.isArray(state?.batches) ? state.batches : [],
    queue: Array.isArray(state?.queue) ? state.queue : []
  };
}

function knownTotalBytes(job) {
  return Number(job.totalBytes || job.expectedBytes || 0);
}

function inferredKnownTotalBytes(job, jobs) {
  const own = knownTotalBytes(job);
  if (own) return own;
  const match = job.filename.match(/^(.*)\.part\d+\.rar$/i);
  if (!match) return 0;
  const siblingTotals = jobs
    .filter((item) => item.id !== job.id && item.filename.startsWith(`${match[1]}.part`))
    .map(knownTotalBytes)
    .filter(Boolean);
  if (!siblingTotals.length) return 0;
  return Math.max(...siblingTotals);
}

function batchStats(batch, jobs) {
  const active = jobs.filter((job) => job.status === 'downloading');
  const downloaded = jobs.reduce((sum, job) => sum + Number(job.downloadedBytes || 0), 0);
  const total = jobs.reduce((sum, job) => sum + inferredKnownTotalBytes(job, jobs), 0);
  const speed = active.reduce((sum, job) => sum + Number(job.speed || 0), 0);
  const averageSpeed = active.reduce((sum, job) => sum + Number(job.averageSpeed || job.speed || 0), 0);
  const remaining = jobs
    .filter((job) => !['done', 'error'].includes(job.status) && inferredKnownTotalBytes(job, jobs))
    .reduce((sum, job) => sum + Math.max(0, inferredKnownTotalBytes(job, jobs) - Number(job.downloadedBytes || 0)), 0);
  const eta = remaining && averageSpeed ? formatDuration(remaining / averageSpeed) : '--';
  const startedAt = batch.startedAt || jobs.find((job) => job.startedAt)?.startedAt;
  const endAt = batch.completedAt || Date.now();
  const elapsed = startedAt ? formatDuration((endAt - startedAt) / 1000) : '--';
  const status = batch.status === 'extracting' || batch.extractionError
    ? batch.status
    : jobs.every((job) => job.status === 'done')
    ? 'done'
    : jobs.every((job) => job.status === 'paused')
      ? 'paused'
      : jobs.every((job) => job.status === 'canceled')
        ? 'canceled'
    : jobs.some((job) => ['queued', 'downloading', 'extracting', 'retrying'].includes(job.status))
      ? 'downloading'
      : jobs.some((job) => job.status === 'error')
        ? 'error'
        : batch.status;

  return { downloaded, total, speed, averageSpeed, eta, elapsed, status };
}

function renderQueueStats(queue) {
  const active = queue.filter((job) => job.status === 'downloading');
  const totalSpeed = active.reduce((sum, job) => sum + Number(job.speed || 0), 0);
  const totalAverageSpeed = active.reduce((sum, job) => sum + Number(job.averageSpeed || job.speed || 0), 0);
  const remainingBytes = queue
    .filter((job) => !['done', 'error'].includes(job.status) && inferredKnownTotalBytes(job, queue))
    .reduce((sum, job) => sum + Math.max(0, inferredKnownTotalBytes(job, queue) - Number(job.downloadedBytes || 0)), 0);
  const eta = remainingBytes && totalAverageSpeed ? formatDuration(remainingBytes / totalAverageSpeed) : '--';

  queueStatsEl.innerHTML = `
    <span>Total speed: <strong>${formatBytes(totalSpeed)}/s</strong></span>
    <span>ETA: <strong>${eta}</strong></span>
  `;
}

function renderQueue(state) {
  latestQueueState = normalizeState(state);
  const { batches, queue } = latestQueueState;
  queueSummaryEl.textContent = `${queue.length} item${queue.length === 1 ? '' : 's'}`;
  renderQueueStats(queue);
  if (!queue.length) {
    queueEl.innerHTML = '<div class="empty">No downloads yet.</div>';
    return;
  }

  queueEl.innerHTML = batches.map((batch) => {
    const jobs = queue.filter((job) => job.batchId === batch.id || (!job.batchId && batch.id === 0));
    if (!jobs.length) return '';
    const stats = batchStats(batch, jobs);
    const statusClass = stats.status === 'error' ? 'badge error' : 'badge';
    const completed = stats.status === 'done';
    const sizeTotal = stats.total ? ` / ${formatBytes(stats.total)}` : '';
    const folderButton = batch.folder
      ? `<button class="small-button" data-open-folder="${escapeHtml(batch.folder)}">Open Folder</button>`
      : '';
    const batchControls = renderBatchControls(batch, jobs, stats);
    return `
      <details class="batch" open>
        <summary class="batch-summary">
          <div>
            <div class="batch-name">${escapeHtml(batch.name || 'Downloads')}</div>
            <div class="batch-meta">
              <span>${jobs.length} file${jobs.length === 1 ? '' : 's'}</span>
              <span>${formatBytes(stats.downloaded)}${sizeTotal}</span>
              <span>${formatBytes(stats.speed)}/s</span>
              <span>ETA ${stats.eta}</span>
              <span>${batch.extractionError ? escapeHtml(batch.extractionError) : completed ? `Done in ${stats.elapsed}` : `Elapsed ${stats.elapsed}`}</span>
            </div>
          </div>
          <div class="batch-actions">
            ${completed ? folderButton : ''}
            ${batchControls}
            <span class="${statusClass}">${escapeHtml(stats.status)}</span>
          </div>
        </summary>
        <div class="batch-files">
          ${renderBatchFiles(jobs)}
        </div>
      </details>
    `;
  }).join('');
}

function renderBatchFiles(jobs) {
  const groups = new Map();
  const loose = [];

  jobs.forEach((job) => {
    const match = job.filename.match(/^(.*)\.part\d+\.rar$/i);
    if (!match) {
      loose.push(job);
      return;
    }
    const key = match[1];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  });

  const groupHtml = [...groups.entries()].map(([name, parts]) => {
    const sorted = parts.sort((a, b) => partNumber(a.filename) - partNumber(b.filename));
    const stats = batchStats({ status: 'downloading' }, sorted);
    return `
      <details class="part-group" open>
        <summary>
          <span>${escapeHtml(name)}</span>
          <span>${sorted.length} parts &middot; ${formatBytes(stats.downloaded)}${stats.total ? ` / ${formatBytes(stats.total)}` : ''} &middot; ${formatBytes(stats.speed)}/s &middot; ETA ${stats.eta}</span>
        </summary>
        <div class="part-files">${sorted.map(renderJob).join('')}</div>
      </details>
    `;
  }).join('');

  return `${groupHtml}${loose.map(renderJob).join('')}`;
}

function renderBatchControls(batch, jobs, stats) {
  const id = Number(batch.id);
  const buttons = [];
  const hasPausable = jobs.some((job) => ['queued', 'downloading', 'retrying'].includes(job.status));
  const hasPaused = jobs.some((job) => job.status === 'paused');
  const hasCancelable = jobs.some((job) => !['done', 'canceled'].includes(job.status));

  if (hasPausable) {
    buttons.push(`<button class="small-button" data-batch-action="pause" data-batch-id="${id}">Pause All</button>`);
  }
  if (hasPaused) {
    buttons.push(`<button class="small-button" data-batch-action="resume" data-batch-id="${id}">Resume All</button>`);
  }
  if (hasCancelable) {
    buttons.push(`<button class="small-button danger" data-batch-action="cancel" data-batch-id="${id}">Cancel All</button>`);
  }
  buttons.push(`<button class="small-button danger" data-batch-action="delete" data-batch-id="${id}">Delete All</button>`);

  return buttons.join('');
}

function partNumber(filename) {
  const match = filename.match(/\.part(\d+)\.rar$/i);
  return Number(match?.[1] || 0);
}

function renderJob(job) {
    const statusClass = job.status === 'error' ? 'badge error' : 'badge';
    const jobTotal = knownTotalBytes(job);
    const total = jobTotal ? ` / ${formatBytes(jobTotal)}` : '';
    const speed = job.speed ? `${formatBytes(job.speed)}/s` : '';
    const averageSpeed = job.averageSpeed ? `${formatBytes(job.averageSpeed)}/s avg` : '';
    const remaining = jobTotal - Number(job.downloadedBytes || 0);
    const eta = job.status === 'downloading' && remaining > 0 && job.averageSpeed
      ? `ETA ${formatDuration(remaining / job.averageSpeed)}`
      : '';
    const retry = job.status === 'retrying' && job.retryAt
      ? `Retrying in ${formatDuration((job.retryAt - Date.now()) / 1000)}`
      : '';
    const metaParts = [escapeHtml(job.message || ''), speed, averageSpeed, eta, retry].filter(Boolean);
    const controls = renderJobControls(job);
    return `
      <article class="job">
        <div class="job-top">
          <div class="filename" title="${escapeHtml(job.filename)}">${escapeHtml(job.filename)}</div>
          <div class="job-actions">
            ${controls}
            <span class="${statusClass}">${escapeHtml(job.status)}</span>
          </div>
        </div>
        <div class="progress"><span style="width:${job.progress || 0}%"></span></div>
        <div class="job-meta">
          <span>${formatBytes(job.downloadedBytes)}${total}</span>
          <span>${metaParts.join(' &middot; ')}</span>
        </div>
      </article>
    `;
}

function renderJobControls(job) {
  const id = Number(job.id);
  const buttons = [];
  if (['queued', 'downloading', 'retrying'].includes(job.status)) {
    buttons.push(`<button class="tiny-button" data-job-action="pause" data-job-id="${id}">Pause</button>`);
    buttons.push(`<button class="tiny-button danger" data-job-action="cancel" data-job-id="${id}">Cancel</button>`);
  }
  if (job.status === 'paused') {
    buttons.push(`<button class="tiny-button" data-job-action="resume" data-job-id="${id}">Resume</button>`);
    buttons.push(`<button class="tiny-button danger" data-job-action="cancel" data-job-id="${id}">Cancel</button>`);
  }
  buttons.push(`<button class="tiny-button danger" data-job-action="delete" data-job-id="${id}">Delete</button>`);
  return buttons.join('');
}

function renderRequirements(requirements) {
  const fullSevenZip = requirements.fullSevenZip;
  const status = fullSevenZip.available ? 'Ready' : 'Missing';
  const statusClass = fullSevenZip.available ? 'ok' : 'warn';
  const detail = fullSevenZip.available
    ? `Full 7-Zip found at ${fullSevenZip.path}`
    : 'Install full 7-Zip to extract multipart RAR archives.';

  requirementsEl.innerHTML = `
    <div class="requirement ${statusClass}">
      <div>
        <span>7-Zip</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
      <p>${escapeHtml(detail)}</p>
    </div>
  `;
}

function renderLinkOnlyMode() {
  const enabled = Boolean(settings.linkOnlyMode);
  toggleLinkOnlyEl.textContent = enabled ? 'Link Only: On' : 'Link Only: Off';
  toggleLinkOnlyEl.classList.toggle('active', enabled);
  toggleLinkOnlyEl.setAttribute('aria-pressed', String(enabled));
}

function renderCapturedLinks(links) {
  capturedLinks = Array.isArray(links) ? links : [];
  linkPadCountEl.textContent = `${capturedLinks.length} link${capturedLinks.length === 1 ? '' : 's'}`;
  capturedLinksTextEl.value = capturedLinks.map((link) => link.sourceUrl).join('\n');
}

function renderResolverStatus(status) {
  const messages = {
    'blocked-popup': 'Blocked popup tab',
    'download-started': 'Captured browser download',
    'link-captured': 'Captured final link',
    'direct-url': 'Queued direct file link',
    'found-direct': 'Found direct file link',
    clicked: 'Clicked likely download control',
    stopped: 'Stopped auto resolver',
    error: 'Auto resolver error'
  };
  const label = messages[status.type] || 'Auto resolver update';
  const detail = status.label || status.message || status.url || '';
  resolverStatusEl.textContent = detail ? `${label}: ${detail}` : label;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

async function persistSettings() {
  settings = await window.ffdownloader.updateSettings({
    concurrency: Number(concurrencyEl.value),
    extractArchives: extractArchivesEl.checked,
    deleteArchives: deleteArchivesEl.checked,
    linkOnlyMode: Boolean(settings.linkOnlyMode)
  });
  renderLinkOnlyMode();
}

document.querySelector('#chooseFolder').addEventListener('click', async () => {
  outputDirEl.textContent = await window.ffdownloader.chooseOutputDir();
});

document.querySelector('#openBrowser').addEventListener('click', async () => {
  await persistSettings();
  await window.ffdownloader.openForResolution(parseLinks());
});

document.querySelector('#autoResolve').addEventListener('click', async () => {
  await persistSettings();
  const count = await window.ffdownloader.autoResolve(parseLinks());
  resolverStatusEl.textContent = count
    ? `Auto resolver started for ${count} link${count === 1 ? '' : 's'}.`
    : 'Paste at least one valid link to auto resolve.';
});

document.querySelector('#addDirect').addEventListener('click', async () => {
  await persistSettings();
  await window.ffdownloader.addDirect(parseLinks());
});

toggleLinkOnlyEl.addEventListener('click', async () => {
  settings.linkOnlyMode = !settings.linkOnlyMode;
  await persistSettings();
  linkPadEl.hidden = !settings.linkOnlyMode && !capturedLinks.length;
  resolverStatusEl.textContent = settings.linkOnlyMode
    ? 'Link Only mode is on. Captured final links will be saved without downloading.'
    : 'Link Only mode is off. Captured links will download normally.';
});

document.querySelector('#openLinkPad').addEventListener('click', async () => {
  linkPadEl.hidden = false;
  renderCapturedLinks(await window.ffdownloader.getCapturedLinks());
  capturedLinksTextEl.focus();
});

document.querySelector('#closeLinkPad').addEventListener('click', () => {
  linkPadEl.hidden = true;
});

document.querySelector('#copyCapturedLinks').addEventListener('click', async () => {
  await navigator.clipboard.writeText(capturedLinksTextEl.value);
  resolverStatusEl.textContent = `Copied ${capturedLinks.length} captured link${capturedLinks.length === 1 ? '' : 's'}.`;
});

document.querySelector('#clearCapturedLinks').addEventListener('click', async () => {
  renderCapturedLinks(await window.ffdownloader.clearCapturedLinks());
  resolverStatusEl.textContent = 'Captured links cleared.';
});

queueEl.addEventListener('click', async (event) => {
  const batchButton = event.target.closest('[data-batch-action]');
  if (batchButton) {
    event.preventDefault();
    event.stopPropagation();
    const batchId = Number(batchButton.dataset.batchId);
    const action = batchButton.dataset.batchAction;
    try {
      if (action === 'pause') await window.ffdownloader.pauseBatch(batchId);
      if (action === 'resume') await window.ffdownloader.resumeBatch(batchId);
      if (action === 'cancel') await window.ffdownloader.cancelBatch(batchId);
      if (action === 'delete') await window.ffdownloader.deleteBatch(batchId);
    } catch (error) {
      resolverStatusEl.textContent = error.message || `Could not ${action} bundle.`;
    }
    return;
  }

  const actionButton = event.target.closest('[data-job-action]');
  if (actionButton) {
    event.preventDefault();
    event.stopPropagation();
    const jobId = Number(actionButton.dataset.jobId);
    const action = actionButton.dataset.jobAction;
    try {
      if (action === 'pause') await window.ffdownloader.pauseJob(jobId);
      if (action === 'resume') await window.ffdownloader.resumeJob(jobId);
      if (action === 'cancel') await window.ffdownloader.cancelJob(jobId);
      if (action === 'delete') await window.ffdownloader.deleteJob(jobId);
    } catch (error) {
      resolverStatusEl.textContent = error.message || `Could not ${action} download.`;
    }
    return;
  }

  const button = event.target.closest('[data-open-folder]');
  if (!button) return;
  try {
    await window.ffdownloader.openFolder(button.dataset.openFolder);
  } catch (error) {
    resolverStatusEl.textContent = error.message || 'Could not open folder.';
  }
});

[concurrencyEl, extractArchivesEl, deleteArchivesEl].forEach((control) => {
  control.addEventListener('change', persistSettings);
});

setInterval(() => {
  const hasLiveRows = latestQueueState.queue.some((job) => ['downloading', 'retrying'].includes(job.status));
  if (hasLiveRows) renderQueue(latestQueueState);
}, 1000);

window.ffdownloader.onQueueChanged(renderQueue);
window.ffdownloader.onCapturedLinksChanged((links) => {
  renderCapturedLinks(links);
  if (settings.linkOnlyMode || !linkPadEl.hidden) linkPadEl.hidden = false;
});
window.ffdownloader.onRequirementsChecked(renderRequirements);
window.ffdownloader.onResolverStatus(renderResolverStatus);

(async function init() {
  settings = await window.ffdownloader.getSettings();
  renderLinkOnlyMode();
  renderCapturedLinks(await window.ffdownloader.getCapturedLinks());
  linkPadEl.hidden = !settings.linkOnlyMode && !capturedLinks.length;
  renderRequirements(await window.ffdownloader.getRequirements());
  outputDirEl.textContent = settings.outputDir;
  concurrencyEl.value = settings.concurrency;
  extractArchivesEl.checked = settings.extractArchives;
  deleteArchivesEl.checked = settings.deleteArchives;
  renderQueue(await window.ffdownloader.getQueue());
}());
