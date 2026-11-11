window.__probeErrors = [];
window.__probeCSP = [];
window.addEventListener('error', (event) => window.__probeErrors.push({
  message: event.message, file: event.filename, line: event.lineno, column: event.colno,
  stack: event.error?.stack, detail: String(event.error), time: performance.now(), readyState: document.readyState,
}));
window.addEventListener('unhandledrejection', (event) => window.__probeErrors.push({ rejection: String(event.reason), stack: event.reason?.stack }));
window.addEventListener('securitypolicyviolation', (event) => window.__probeCSP.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
// Preserve the actual exception before WebKit masks errors from injected scripts.
const originalTimeout = window.setTimeout;
window.setTimeout = function(callback, delay, ...args) {
  if (typeof callback !== 'function') return originalTimeout(callback, delay, ...args);
  return originalTimeout(function(...values) {
    try { return callback(...values); }
    catch (error) { window.__probeErrors.push({ timerError: String(error), stack: error?.stack }); throw error; }
  }, delay, ...args);
};
