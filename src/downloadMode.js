function resolveDownloadMode(download) {
  return download?.captureMode === 'browser' ? 'browser' : 'network';
}

module.exports = {
  resolveDownloadMode
};
