// scripts/spawn-windows-hide.mjs — default `windowsHide: true` for every
// child_process call in this process (win32 only; a no-op elsewhere).
//
// Why: a process started with `windowsHide: true` (CREATE_NO_WINDOW) owns no
// console. Every console program it then spawns WITHOUT that flag — git,
// getconf, taskkill, a node helper — gets a brand-new console from Windows,
// which the default terminal (Windows Terminal) shows as a window and keeps
// open after the process exits. The console-less roots in this repo are the
// detached child watcher (supervisor-watch.mjs), the test servers spawned by
// test-spawn.mjs and any server started from a GUI tool. One full suite run
// left 240 empty "Terminal" windows on a desktop this way (2026-10-26).
//
// Patching ~300 spawn sites one by one is not a fix. Instead this module is
// loaded first and makes the default the safe one; a caller that passes
// windowsHide explicitly keeps its value. Loaded two ways:
//   - `import "./spawn-windows-hide.mjs"` at the top of a console-less process
//     (supervisor-watch.mjs);
//   - `NODE_OPTIONS=--import <file url>` set by test-run.mjs for every suite
//     process on win32, so test files and the node children they spawn inherit
//     it without touching each file.
// Builtin ESM named imports (`import { spawn } from "node:child_process"`) are
// live bindings of the CJS object, refreshed by syncBuiltinESMExports().

import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

if (process.platform === "win32" && !cp.spawn.__windowsHideDefault) {
  const withHide = (opts) =>
    opts && typeof opts === "object" && !Array.isArray(opts)
      ? (opts.windowsHide === undefined ? { ...opts, windowsHide: true } : opts)
      : opts;

  // spawn/spawnSync/fork: (file, args?, options?) — options is the last object
  // argument; args may be omitted.
  const wrapSpawnLike = (fn) =>
    Object.assign(
      function (file, args, options) {
        if (Array.isArray(args)) return fn.call(this, file, args, withHide(options === undefined ? {} : options));
        if (args && typeof args === "object") return fn.call(this, file, withHide(args));
        return fn.call(this, file, args, withHide(options === undefined ? {} : options));
      },
      { __windowsHideDefault: true },
    );

  // exec/execFile carry a custom promisify (util.promisify(execFile) resolves
  // to { stdout, stderr } and rejects with an error that has both attached).
  // A plain wrapper function would lose it and promisified callers would get
  // a bare stdout string — so the wrapper gets its own custom that routes
  // through the patched call and keeps Node's shape.
  const attachPromisify = (wrapper) => {
    Object.defineProperty(wrapper, promisify.custom, {
      enumerable: false,
      configurable: true,
      value: (...args) =>
        new Promise((resolvePromise, rejectPromise) => {
          const child = wrapper(...args, (err, stdout, stderr) => {
            if (err) {
              err.stdout = stdout;
              err.stderr = stderr;
              rejectPromise(err);
            } else {
              resolvePromise({ stdout, stderr });
            }
          });
          // Node's promisified exec exposes the child too.
          if (child && typeof child === "object") {
            Object.defineProperty(resolvePromise, "child", { value: child });
          }
        }),
    });
    return wrapper;
  };

  // exec/execFile(+Sync): (file, args?, options?, callback?) — the options
  // object may sit at position 1 or 2, before an optional callback.
  const wrapExecLike = (fn) =>
    Object.assign(
      function (...callArgs) {
        let patched = false;
        for (let i = 1; i < callArgs.length; i++) {
          const a = callArgs[i];
          if (a && typeof a === "object" && !Array.isArray(a)) {
            callArgs[i] = withHide(a);
            patched = true;
            break;
          }
          if (typeof a === "function") break;
        }
        if (!patched) {
          // No options object given: insert one before the callback (if any).
          const cbIndex = callArgs.findIndex((a, i) => i > 0 && typeof a === "function");
          if (cbIndex === -1) callArgs.push({ windowsHide: true });
          else callArgs.splice(cbIndex, 0, { windowsHide: true });
        }
        return fn.apply(this, callArgs);
      },
      { __windowsHideDefault: true },
    );

  cp.spawn = wrapSpawnLike(cp.spawn);
  cp.spawnSync = wrapSpawnLike(cp.spawnSync);
  cp.fork = wrapSpawnLike(cp.fork);
  cp.execFile = attachPromisify(wrapExecLike(cp.execFile));
  cp.execFileSync = wrapExecLike(cp.execFileSync);
  cp.exec = attachPromisify(wrapExecLike(cp.exec));
  cp.execSync = wrapExecLike(cp.execSync);
  syncBuiltinESMExports();
}
