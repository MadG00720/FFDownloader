const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ffdownloader', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  chooseOutputDir: () => ipcRenderer.invoke('dialog:outputDir'),
  openForResolution: (links) => ipcRenderer.invoke('links:openForResolution', links),
  autoResolve: (links) => ipcRenderer.invoke('links:autoResolve', links),
  addDirect: (links) => ipcRenderer.invoke('downloads:addDirect', links),
  getQueue: () => ipcRenderer.invoke('queue:get'),
  getCapturedLinks: () => ipcRenderer.invoke('captured-links:get'),
  clearCapturedLinks: () => ipcRenderer.invoke('captured-links:clear'),
  pauseJob: (jobId) => ipcRenderer.invoke('job:pause', jobId),
  resumeJob: (jobId) => ipcRenderer.invoke('job:resume', jobId),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  deleteJob: (jobId) => ipcRenderer.invoke('job:delete', jobId),
  pauseBatch: (batchId) => ipcRenderer.invoke('batch:pause', batchId),
  resumeBatch: (batchId) => ipcRenderer.invoke('batch:resume', batchId),
  cancelBatch: (batchId) => ipcRenderer.invoke('batch:cancel', batchId),
  deleteBatch: (batchId) => ipcRenderer.invoke('batch:delete', batchId),
  getRequirements: () => ipcRenderer.invoke('requirements:get'),
  openFolder: (folderPath) => ipcRenderer.invoke('folder:open', folderPath),
  onQueueChanged: (callback) => {
    ipcRenderer.on('queue:changed', (_event, queue) => callback(queue));
  },
  onCapturedLinksChanged: (callback) => {
    ipcRenderer.on('captured-links:changed', (_event, links) => callback(links));
  },
  onRequirementsChecked: (callback) => {
    ipcRenderer.on('requirements:checked', (_event, requirements) => callback(requirements));
  },
  onResolverStatus: (callback) => {
    ipcRenderer.on('resolver:status', (_event, status) => callback(status));
  }
});
