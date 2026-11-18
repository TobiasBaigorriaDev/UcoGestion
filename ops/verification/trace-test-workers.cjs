// Diagnostic preload only. Capture exit status Vitest's generic worker error
// omits, without logging arguments, environment, payloads or credentials.
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const originalFork = childProcess.fork;

childProcess.fork = function tracedFork(...args) {
  const started = Date.now();
  const worker = Reflect.apply(originalFork, this, args);
  worker.once('exit', (exitCode, signal) => {
    process.stderr.write(`[test-worker-exit] ${JSON.stringify({
      parentPid: process.pid, pid: worker.pid, exitCode, signal, elapsedMs: Date.now() - started,
    })}\n`);
  });
  return worker;
};
syncBuiltinESMExports();
