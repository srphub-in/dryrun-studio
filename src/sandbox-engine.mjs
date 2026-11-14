// File: src/sandbox-engine.mjs
// Dry Run Studio v1.0.0 — Check it on localhost before it goes to cloud.
// © 2026 SRP Hub (https://srphub.in) • MIT Open-Source License

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execSync, exec } from 'node:child_process';

export const STUDIO_VERSION = '1.0.0';
export const STUDIO_BRAND = 'Dry Run Studio';
export const STUDIO_COPYRIGHT = '© 2026 SRP Hub (srphub.in)';
export const SENTINEL_FILENAME = '.dryrun_sandbox_sentinel';
export const DEFAULT_SYSTEM_SANDBOX = path.join(os.homedir(), 'Documents', 'DryRun_Sandbox');

const MAX_LOG_LINES = 5000;

export const TEXT_CODE_EXTS = new Set([
  '.astro', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
  '.vue', '.svelte', '.html', '.css', '.scss', '.json',
  '.md', '.txt', '.xml', '.svg', '.yaml', '.yml', '.toml', '.ini'
]);

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf'
};

const RUNTIME_TELEMETRY_SNIPPET = `<script>
(function(){
  if (window.__dryRunTelemetryActive) return;
  window.__dryRunTelemetryActive = true;
  function postIssue(kind, message, detail, stack) {
    try {
      window.parent.postMessage({
        __sandboxRuntimeIssue: true,
        kind: kind,
        route: window.location.pathname,
        message: String(message || 'Unknown error'),
        detail: String(detail || ''),
        stack: String(stack || '')
      }, '*');
    } catch (e) {}
  }
  window.addEventListener('error', function(e) {
    if (e.target && (e.target.tagName === 'IMG' || e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK')) {
      var url = e.target.src || e.target.href || '';
      postIssue('ASSET_LOAD_ERROR', 'Failed to load <' + e.target.tagName.toLowerCase() + '>', url, '');
      return;
    }
    var loc = (e.filename ? e.filename.split('/').pop() : '') + (e.lineno ? ':' + e.lineno + ':' + (e.colno || 0) : '');
    var st = e.error && e.error.stack ? e.error.stack : '';
    postIssue('UNCAUGHT_JS_ERROR', e.message || 'Runtime Script Error', loc, st);
  }, true);
  window.addEventListener('unhandledrejection', function(e) {
    var reason = e.reason ? (e.reason.message || String(e.reason)) : 'Unhandled Promise Rejection';
    var st = e.reason && e.reason.stack ? e.reason.stack : '';
    postIssue('UNHANDLED_PROMISE', reason, '', st);
  });
  var origErr = console.error;
  console.error = function() {
    try {
      var args = Array.prototype.slice.call(arguments);
      var st = '';
      var msg = args.map(function(a) {
        if (a instanceof Error) {
          st = a.stack || '';
          return a.message;
        }
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
      }).join(' ');
      postIssue('CONSOLE_ERROR', msg, '', st);
    } catch (e) {}
    return origErr.apply(console, arguments);
  };
})();
</script>`;

export const sandboxState = {
  sseClients: [],
  activeBuildProc: null,
  previewServer: null,
  previewPort: 8788,
  sourceWatcher: null,
  watchDebounceTimer: null,
  currentSourceDir: '',
  currentProjectSlug: '',
  lastSyncedSourceDir: '',
  isBuilding: false,
  isCleaningUp: false,
  getSandboxPathsFn: null,
  onRepoTestedCallback: null,
  buildHistory: {
    projectName: '',
    projectSlug: '',
    framework: '',
    sourceDir: '',
    startTimeIso: '',
    durationSec: '0.0',
    status: 'IDLE',
    exitCode: null,
    baselineExisted: false,
    logs: [],
    compilerErrorBlocks: [],
    runtimeErrors: [],
    preflightIssues: [],
    changedFiles: [],
    smokeTest: null,
    customHeadersLoaded: 0,
    audit: null,
    lastCloudflareDeployment: null
  }
};

export function initSandboxEngine({ getSandboxPathsFn, onRepoTestedCallback }) {
  sandboxState.getSandboxPathsFn = getSandboxPathsFn;
  sandboxState.onRepoTestedCallback = onRepoTestedCallback;
}

export function stripAnsiCodes(str) {
  return String(str || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function sendLog(rawText, type = 'info', channel = 'sandbox') {
  const text = stripAnsiCodes(rawText);
  const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
  sandboxState.buildHistory.logs.push({ ts, type, text, channel });
  if (sandboxState.buildHistory.logs.length > MAX_LOG_LINES) {
    sandboxState.buildHistory.logs.shift();
  }
  const payload = JSON.stringify({ text, type, ts, channel });
  sandboxState.sseClients.forEach((res) => {
    try { res.write(`data: ${payload}\n\n`); } catch (e) {}
  });
}

export function sendStatus(state, extra = {}) {
  const payload = JSON.stringify({ state, ...extra });
  sandboxState.sseClients.forEach((res) => {
    try { res.write(`event: status\ndata: ${payload}\n\n`); } catch (e) {}
  });
}

export function validateSandboxPathSafety(candidatePath, sourceRepoPath = '') {
  if (!candidatePath || typeof candidatePath !== 'string') {
    return { valid: false, reason: 'Sandbox directory path cannot be empty.' };
  }
  const resolved = path.resolve(candidatePath.trim());
  const lower = resolved.toLowerCase();

  if (/^[a-z]:\\?$/i.test(resolved)) {
    return { valid: false, reason: 'Drive root directories (e.g., C:\\ or D:\\) cannot be used directly. Select a dedicated subfolder.' };
  }

  const forbiddenPrefixes = [
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    'c:\\system volume information'
  ];
  for (const fp of forbiddenPrefixes) {
    if (lower === fp || lower.startsWith(fp + '\\')) {
      return { valid: false, reason: `System directory "${resolved}" is protected.` };
    }
  }

  if (sourceRepoPath && fs.existsSync(sourceRepoPath)) {
    const resolvedSrc = path.resolve(sourceRepoPath).toLowerCase();
    if (lower === resolvedSrc || lower.startsWith(resolvedSrc + '\\') || resolvedSrc.startsWith(lower + '\\')) {
      return { valid: false, reason: 'Sandbox directory must be completely separate from your active project repository.' };
    }
  }

  return { valid: true, resolved };
}

export function detectFrameworkBadge(pkg) {
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (allDeps.astro) return `Astro ${allDeps.astro}`;
  if (allDeps.next) return `Next.js ${allDeps.next}`;
  if (allDeps.nuxt) return `Nuxt ${allDeps.nuxt}`;
  if (allDeps.svelte || allDeps['@sveltejs/kit']) return 'SvelteKit';
  if (allDeps.vue) return `Vue ${allDeps.vue}`;
  if (allDeps.react) return `React ${allDeps.react}`;
  if (allDeps.vite) return `Vite ${allDeps.vite}`;
  return 'Static / Node';
}

export function getProjectSlugFromDir(resolvedSrc) {
  try {
    const pkgPath = path.join(resolvedSrc, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return String(pkg.name || path.basename(resolvedSrc)).replace(/[^a-zA-Z0-9_-]/g, '_');
    }
  } catch (e) {}
  return String(path.basename(resolvedSrc)).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function stopFileWatcher() {
  if (sandboxState.sourceWatcher) {
    try { sandboxState.sourceWatcher.close(); } catch (e) {}
    sandboxState.sourceWatcher = null;
  }
}

export function configureFileWatcher(enable, dirToWatch) {
  stopFileWatcher();
  if (!enable || !dirToWatch || !fs.existsSync(dirToWatch)) return false;

  try {
    sandboxState.sourceWatcher = fs.watch(dirToWatch, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const norm = filename.replace(/\\/g, '/');
      if (
        norm.startsWith('.git/') ||
        norm.startsWith('node_modules/') ||
        norm.startsWith('dist/') ||
        norm.startsWith('.astro/') ||
        norm.endsWith('~') ||
        norm.endsWith('.tmp')
      ) {
        return;
      }
      clearTimeout(sandboxState.watchDebounceTimer);
      sandboxState.watchDebounceTimer = setTimeout(() => {
        if (!sandboxState.isBuilding && sandboxState.currentSourceDir) {
          sendLog(`[AUTO-WATCH] File change detected in "${norm}" -> Rebuilding sandbox...`, 'info');
          runSandboxBuild(sandboxState.currentSourceDir, true);
        }
      }, 650);
    });
    return true;
  } catch (e) {
    return false;
  }
}

export function saveDirectoryAsRollingBaseline(sourceOrSandboxDir, projectSlug) {
  if (!sourceOrSandboxDir || !projectSlug || !fs.existsSync(sourceOrSandboxDir)) return false;
  const { lastStateDir } = sandboxState.getSandboxPathsFn(sandboxState.currentSourceDir || sourceOrSandboxDir);
  const targetBaseDir = path.join(lastStateDir, projectSlug);
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.astro', '.next', '.nuxt', '.git', '.wrangler', 'admin-local', 'dist-portable']);
  const binaryManifest = {};

  try {
    if (fs.existsSync(targetBaseDir)) {
      fs.rmSync(targetBaseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(targetBaseDir, { recursive: true });

    function walkAndSnapshot(curSrc, curDest, isRoot = false) {
      fs.mkdirSync(curDest, { recursive: true });
      const entries = fs.readdirSync(curSrc, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name === SENTINEL_FILENAME) continue;
        if (isRoot && SKIP_DIRS.has(entry.name)) continue;
        const sPath = path.join(curSrc, entry.name);
        const dPath = path.join(curDest, entry.name);
        const rel = path.relative(sourceOrSandboxDir, sPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          walkAndSnapshot(sPath, dPath, false);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const stat = fs.statSync(sPath);
          const isSmallText = TEXT_CODE_EXTS.has(ext) && stat.size <= 512 * 1024;

          if (isSmallText) {
            fs.copyFileSync(sPath, dPath);
            try { fs.utimesSync(dPath, stat.atime, stat.mtime); } catch (e) {}
          } else {
            const hash = crypto.createHash('sha1');
            hash.update(fs.readFileSync(sPath));
            binaryManifest[rel] = { size: stat.size, sha1: hash.digest('hex') };
          }
        }
      }
    }

    walkAndSnapshot(sourceOrSandboxDir, targetBaseDir, true);
    fs.writeFileSync(
      path.join(targetBaseDir, '__binary_manifest__.json'),
      JSON.stringify({ savedAtIso: new Date().toISOString(), files: binaryManifest }, null, 2),
      'utf-8'
    );
    return true;
  } catch (e) {
    return false;
  }
}

export function promoteSourceToRollingBaseline(repoDir) {
  const targetDir = repoDir || sandboxState.currentSourceDir;
  if (!targetDir || !fs.existsSync(targetDir)) return false;
  const resolved = path.resolve(targetDir);
  const slug = getProjectSlugFromDir(resolved);
  const ok = saveDirectoryAsRollingBaseline(resolved, slug);
  if (ok) {
    sandboxState.buildHistory.changedFiles = [];
    sendLog(`[BASELINE AUTO-UPDATED] Cloud deployment succeeded -> Set "${slug}" current state as new Rolling Baseline!`, 'success', 'deploy');
    sendStatus('baseline-promoted', { projectSlug: slug, changedCount: 0 });
  }
  return ok;
}

export function compareDirectoryAgainstRollingBaseline(targetDir, projectSlug) {
  const { lastStateDir } = sandboxState.getSandboxPathsFn(sandboxState.currentSourceDir || targetDir);
  const targetBaseDir = path.join(lastStateDir, projectSlug);
  const manifestPath = path.join(targetBaseDir, '__binary_manifest__.json');
  if (!fs.existsSync(targetBaseDir) || !fs.existsSync(manifestPath)) {
    return { baselineExisted: false, changes: [] };
  }

  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.astro', '.next', '.nuxt', '.git', '.wrangler', 'admin-local', 'dist-portable']);
  let savedBinaryManifest = {};
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    savedBinaryManifest = raw.files || {};
  } catch (e) {}

  const baseTextFiles = new Map();
  function walkBase(d) {
    const items = fs.readdirSync(d, { withFileTypes: true });
    for (const item of items) {
      if (item.name === '__binary_manifest__.json' || item.name === SENTINEL_FILENAME) continue;
      const full = path.join(d, item.name);
      if (item.isDirectory()) {
        walkBase(full);
      } else if (item.isFile()) {
        const rel = path.relative(targetBaseDir, full).replace(/\\/g, '/');
        baseTextFiles.set(rel, full);
      }
    }
  }
  try { walkBase(targetBaseDir); } catch (e) {}

  const changes = [];
  const seenInCurrent = new Set();

  function walkCurrent(d, isRoot = false) {
    const items = fs.readdirSync(d, { withFileTypes: true });
    for (const item of items) {
      if (item.name === SENTINEL_FILENAME) continue;
      if (isRoot && SKIP_DIRS.has(item.name)) continue;
      const full = path.join(d, item.name);
      if (item.isDirectory()) {
        walkCurrent(full, false);
      } else if (item.isFile()) {
        const rel = path.relative(targetDir, full).replace(/\\/g, '/');
        seenInCurrent.add(rel);
        const stat = fs.statSync(full);
        const ext = path.extname(item.name).toLowerCase();
        const isSmallText = TEXT_CODE_EXTS.has(ext) && stat.size <= 512 * 1024;
        const sizeKB = (stat.size / 1024).toFixed(1);

        if (isSmallText) {
          if (!baseTextFiles.has(rel)) {
            changes.push({ status: 'ADDED', file: rel, sizeKB, canDiff: true });
          } else {
            const baseFull = baseTextFiles.get(rel);
            const curText = fs.readFileSync(full, 'utf-8').replace(/\r\n/g, '\n');
            const baseText = fs.readFileSync(baseFull, 'utf-8').replace(/\r\n/g, '\n');
            if (curText !== baseText) {
              changes.push({ status: 'MODIFIED', file: rel, sizeKB, canDiff: true });
            }
          }
        } else {
          if (!savedBinaryManifest[rel]) {
            changes.push({ status: 'ADDED', file: rel, sizeKB, canDiff: false });
          } else {
            const prevMeta = savedBinaryManifest[rel];
            if (prevMeta.size !== stat.size) {
              changes.push({ status: 'MODIFIED', file: rel, sizeKB, canDiff: false });
            } else {
              const hash = crypto.createHash('sha1');
              hash.update(fs.readFileSync(full));
              if (hash.digest('hex') !== prevMeta.sha1) {
                changes.push({ status: 'MODIFIED', file: rel, sizeKB, canDiff: false });
              }
            }
          }
        }
      }
    }
  }

  try { walkCurrent(targetDir, true); } catch (e) {}

  for (const [rel, baseFull] of baseTextFiles.entries()) {
    if (!seenInCurrent.has(rel)) {
      const st = fs.statSync(baseFull);
      changes.push({ status: 'DELETED', file: rel, sizeKB: (st.size / 1024).toFixed(1), canDiff: true });
    }
  }
  for (const [rel, meta] of Object.entries(savedBinaryManifest)) {
    if (!seenInCurrent.has(rel)) {
      changes.push({ status: 'DELETED', file: rel, sizeKB: (meta.size / 1024).toFixed(1), canDiff: false });
    }
  }

  return { baselineExisted: true, changes };
}

export function computeLineByLineDiff(relFilePath, projectSlug) {
  const { workDir, lastStateDir } = sandboxState.getSandboxPathsFn(sandboxState.currentSourceDir);
  const safeRel = String(relFilePath || '').replace(/\.\./g, '');
  const baseFile = path.join(lastStateDir, projectSlug, safeRel);
  const activeRoot = fs.existsSync(workDir) ? workDir : sandboxState.currentSourceDir;
  const curFile = activeRoot ? path.join(activeRoot, safeRel) : '';

  const oldLines = fs.existsSync(baseFile)
    ? fs.readFileSync(baseFile, 'utf-8').replace(/\r\n/g, '\n').split('\n')
    : [];
  const newLines = (curFile && fs.existsSync(curFile))
    ? fs.readFileSync(curFile, 'utf-8').replace(/\r\n/g, '\n').split('\n')
    : [];

  const N = oldLines.length;
  const M = newLines.length;
  if (N + M > 2500) {
    return [{ type: 'info', text: 'File exceeds 2,500 lines — showing summary only.' }];
  }

  const dp = Array.from({ length: N + 1 }, () => new Int32Array(M + 1));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = 1 + dp[i + 1][j + 1];
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rawDiff = [];
  let i = 0, j = 0, oldLn = 1, newLn = 1;
  while (i < N && j < M) {
    if (oldLines[i] === newLines[j]) {
      rawDiff.push({ type: 'same', oldLn: oldLn++, newLn: newLn++, text: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rawDiff.push({ type: 'del', oldLn: oldLn++, newLn: '', text: oldLines[i++] });
    } else {
      rawDiff.push({ type: 'add', oldLn: '', newLn: newLn++, text: newLines[j++] });
    }
  }
  while (i < N) rawDiff.push({ type: 'del', oldLn: oldLn++, newLn: '', text: oldLines[i++] });
  while (j < M) rawDiff.push({ type: 'add', oldLn: '', newLn: newLn++, text: newLines[j++] });

  const CONTEXT = 3;
  const keepIdx = new Set();
  rawDiff.forEach((item, idx) => {
    if (item.type !== 'same') {
      for (let c = Math.max(0, idx - CONTEXT); c <= Math.min(rawDiff.length - 1, idx + CONTEXT); c++) {
        keepIdx.add(c);
      }
    }
  });

  const compactHunks = [];
  let lastIdx = -1;
  for (let idx = 0; idx < rawDiff.length; idx++) {
    if (!keepIdx.has(idx)) continue;
    if (lastIdx !== -1 && idx - lastIdx > 1) {
      compactHunks.push({ type: 'sep', text: '・・・' });
    }
    compactHunks.push(rawDiff[idx]);
    lastIdx = idx;
  }

  return compactHunks;
}

export function wipeSandboxDirectory(deleteAllCachesToo = false, closingApp = false, stopCloudPollerFn = null, closeBrowserFn = null) {
  if (sandboxState.isCleaningUp) return { ok: true };
  sandboxState.isCleaningUp = true;

  try {
    if (closingApp) {
      stopFileWatcher();
      if (typeof stopCloudPollerFn === 'function') stopCloudPollerFn();
    }

    if (sandboxState.activeBuildProc) {
      try { execSync(`taskkill /pid ${sandboxState.activeBuildProc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
      sandboxState.activeBuildProc = null;
    }

    if (sandboxState.previewServer) {
      try { sandboxState.previewServer.close(); } catch (e) {}
      sandboxState.previewServer = null;
    }

    const { base, container, workDir, lastStateDir, engineCacheDir, browserProfileDir } =
      sandboxState.getSandboxPathsFn(sandboxState.currentSourceDir);

    const safety = validateSandboxPathSafety(container, sandboxState.currentSourceDir);
    if (!safety.valid) {
      throw new Error(`Safety Lock Triggered: ${safety.reason}`);
    }

    if (
      closingApp &&
      !deleteAllCachesToo &&
      sandboxState.buildHistory.status === 'SUCCESS' &&
      sandboxState.currentProjectSlug &&
      fs.existsSync(workDir)
    ) {
      try {
        saveDirectoryAsRollingBaseline(workDir, sandboxState.currentProjectSlug);
      } catch (e) {}
    }

    const normalizedWork = path.resolve(workDir);
    if (!normalizedWork.toLowerCase().endsWith('_ephemeral_sandbox_run')) {
      throw new Error('Safety Lock Triggered: WorkDir does not end with _ephemeral_sandbox_run');
    }

    const junctionPath = path.join(normalizedWork, 'node_modules');
    if (fs.existsSync(junctionPath)) {
      try {
        execSync(`rmdir "${junctionPath}"`, { stdio: 'ignore' });
      } catch (e) {
        try { fs.unlinkSync(junctionPath); } catch (err) {}
      }
    }

    if (fs.existsSync(normalizedWork)) {
      try { fs.rmSync(normalizedWork, { recursive: true, force: true }); } catch (e) {}
    }
    sandboxState.lastSyncedSourceDir = '';

    if (deleteAllCachesToo) {
      if (fs.existsSync(engineCacheDir)) {
        try { fs.rmSync(engineCacheDir, { recursive: true, force: true }); } catch (e) {}
      }
      if (fs.existsSync(lastStateDir)) {
        try { fs.rmSync(lastStateDir, { recursive: true, force: true }); } catch (e) {}
      }
    }

    if (closingApp) {
      if (typeof closeBrowserFn === 'function') {
        try { closeBrowserFn(); } catch (e) {}
      }
      if (fs.existsSync(browserProfileDir)) {
        try { fs.rmSync(browserProfileDir, { recursive: true, force: true }); } catch (e) {}
      }
    }

    if (fs.existsSync(container)) {
      const rem = fs.readdirSync(container).filter((n) => n !== SENTINEL_FILENAME);
      if (rem.length === 0) {
        try { fs.rmSync(container, { recursive: true, force: true }); } catch (e) {}
      }
    }
    if (fs.existsSync(base) && base !== container) {
      const remBase = fs.readdirSync(base);
      if (remBase.length === 0) {
        try { fs.rmdirSync(base); } catch (e) {}
      }
    }

    sandboxState.isCleaningUp = false;
    return { ok: true };
  } catch (err) {
    sandboxState.isCleaningUp = false;
    return { ok: false, error: err.message };
  }
}

export function runPreflightGuardOnSandbox(sandboxDir) {
  const issues = [];
  const CODE_EXTS = new Set(['.astro', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.vue', '.svelte', '.html', '.css', '.json']);
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.astro', '.git', 'lib', 'dist-portable']);

  const SECRET_PATTERNS = [
    {
      name: 'Git Merge Conflict Marker',
      regex: new RegExp('^(' + '<'.repeat(7) + ' HEAD|' + '='.repeat(7) + '|' + '>'.repeat(7) + ' )', 'm'),
      severity: 'HIGH'
    },
    { name: 'Hardcoded Payment Gateway Key', regex: /\b(rzp_live_[a-zA-Z0-9]{8,}|sk_live_[a-zA-Z0-9]{12,})\b/, severity: 'WARN' },
    { name: 'Hardcoded Cloudflare API Token', regex: /\bcfat_[a-zA-Z0-9_-]{20,}\b/, severity: 'HIGH' },
    { name: 'Hardcoded GitHub Personal Access Token', regex: /\b(ghp_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,})\b/, severity: 'HIGH' },
    {
      name: 'Private Key Block',
      regex: new RegExp('-'.repeat(5) + 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' + '-'.repeat(5)),
      severity: 'HIGH'
    },
    { name: 'Leftover debugger; Statement', regex: /(?:^|\r?\n)\s*debugger\s*;/, severity: 'WARN' }
  ];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 2 * 1024 * 1024) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          const relPath = path.relative(sandboxDir, fullPath).replace(/\\/g, '/');

          for (const pat of SECRET_PATTERNS) {
            const match = content.match(pat.regex);
            if (match) {
              const upToMatch = content.slice(0, match.index);
              const lineNum = upToMatch.split(/\r?\n/).length;
              issues.push({
                severity: pat.severity,
                rule: pat.name,
                file: relPath,
                line: lineNum
              });
            }
          }
        } catch (e) {}
      }
    }
  }

  try { scanDir(sandboxDir); } catch (e) {}
  return issues;
}

function locateBuildOutputDir(workDir) {
  const candidates = ['dist', 'build', 'out', path.join('.output', 'public'), 'docs'];
  for (const c of candidates) {
    const p = path.join(workDir, c);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      return p;
    }
  }
  return null;
}

function parseCloudflareHeadersFile(outDir) {
  const headersFile = path.join(outDir, '_headers');
  const rules = [];
  if (!fs.existsSync(headersFile)) return rules;

  try {
    const lines = fs.readFileSync(headersFile, 'utf-8').split(/\r?\n/);
    let currentRule = null;
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!line.startsWith(' ') && !line.startsWith('\t')) {
        currentRule = { pattern: line.trim(), headers: {} };
        rules.push(currentRule);
      } else if (currentRule && line.includes(':')) {
        const idx = line.indexOf(':');
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k && v) currentRule.headers[k] = v;
      }
    }
  } catch (e) {}
  return rules;
}

function matchHeaderRulesForIframePreview(pathname, rules) {
  const matched = {};
  for (const r of rules) {
    let isMatch = false;
    if (r.pattern === '/*' || r.pattern === pathname) {
      isMatch = true;
    } else if (r.pattern.endsWith('*')) {
      const prefix = r.pattern.slice(0, -1);
      if (pathname.startsWith(prefix)) isMatch = true;
    }
    if (isMatch) {
      for (const [k, v] of Object.entries(r.headers)) {
        const lowerK = k.toLowerCase();
        if (lowerK === 'x-frame-options') continue;
        if (lowerK === 'content-security-policy') {
          const cleanedCsp = v.replace(/frame-ancestors[^;]*;?/gi, '').trim();
          if (cleanedCsp) matched[k] = cleanedCsp;
          continue;
        }
        matched[k] = v;
      }
    }
  }
  return matched;
}

function runStaticSmokeTest(outDir) {
  const results = {
    routesChecked: 0,
    assetsVerified: 0,
    brokenLinks: []
  };
  const checkedAssets = new Set();

  function verifyLocalRef(routeRel, refUrl) {
    if (!refUrl) return;
    const clean = refUrl.split('?')[0].split('#')[0].trim();
    if (
      !clean ||
      clean.startsWith('http://') ||
      clean.startsWith('https://') ||
      clean.startsWith('//') ||
      clean.startsWith('data:') ||
      clean.startsWith('blob:') ||
      clean.startsWith('mailto:') ||
      clean.startsWith('tel:') ||
      clean.startsWith('javascript:') ||
      clean.includes('${') ||
      clean.includes('{{')
    ) {
      return;
    }

    const hasFileExt = /\.[a-zA-Z0-9]{2,11}$/.test(clean);
    if (!clean.startsWith('/') && !clean.startsWith('./') && !clean.startsWith('../') && !hasFileExt) {
      return;
    }

    let resolvedPath = clean.startsWith('/')
      ? path.join(outDir, clean)
      : path.join(outDir, path.dirname(routeRel), clean);

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      resolvedPath = path.join(resolvedPath, 'index.html');
    } else if (!path.extname(resolvedPath) && fs.existsSync(resolvedPath + '.html')) {
      resolvedPath = resolvedPath + '.html';
    } else if (!path.extname(resolvedPath) && fs.existsSync(path.join(resolvedPath, 'index.html'))) {
      resolvedPath = path.join(resolvedPath, 'index.html');
    }

    if (!fs.existsSync(resolvedPath)) {
      results.brokenLinks.push({
        page: '/' + routeRel.replace(/index\.html$/, ''),
        missingRef: clean
      });
    } else {
      checkedAssets.add(resolvedPath);
    }
  }

  function walkHtml(dir) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walkHtml(full);
      } else if (item.isFile() && item.name.endsWith('.html')) {
        results.routesChecked++;
        const rel = path.relative(outDir, full).replace(/\\/g, '/');
        try {
          const rawHtml = fs.readFileSync(full, 'utf-8');
          const markupOnly = rawHtml
            .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, '<script $1></script>')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

          const tagAttrRegex = /<(?:script|link|img|a|source|iframe)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi;
          let m;
          while ((m = tagAttrRegex.exec(markupOnly)) !== null) {
            verifyLocalRef(rel, m[1]);
          }
        } catch (e) {}
      }
    }
  }

  try { walkHtml(outDir); } catch (e) {}
  results.assetsVerified = checkedAssets.size;
  return results;
}

function auditOutputDirectory(outDir) {
  let totalBytes = 0;
  let fileCount = 0;
  let routes = [];
  let allFiles = [];
  let breakdown = { JS: 0, CSS: 0, HTML: 0, LIB_WASM: 0, FONTS: 0, IMAGES: 0, OTHER: 0 };

  function walk(dir) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        fileCount++;
        const stat = fs.statSync(fullPath);
        totalBytes += stat.size;
        const rel = path.relative(outDir, fullPath).replace(/\\/g, '/');
        const ext = path.extname(item.name).toLowerCase();

        allFiles.push({ path: '/' + rel, bytes: stat.size, kb: (stat.size / 1024).toFixed(1) });

        if (ext === '.html') {
          breakdown.HTML += stat.size;
          if (rel === 'index.html') {
            routes.push('/');
          } else if (rel.endsWith('/index.html')) {
            routes.push('/' + rel.slice(0, -'/index.html'.length));
          } else if (rel !== '404.html') {
            routes.push('/' + rel.replace(/\.html$/, ''));
          }
        } else if (ext === '.js' || ext === '.mjs') {
          if (rel.startsWith('lib/')) breakdown.LIB_WASM += stat.size;
          else breakdown.JS += stat.size;
        } else if (ext === '.css') {
          breakdown.CSS += stat.size;
        } else if (ext === '.wasm' || ext === '.gz') {
          breakdown.LIB_WASM += stat.size;
        } else if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) {
          breakdown.FONTS += stat.size;
        } else if (['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.ico'].includes(ext)) {
          breakdown.IMAGES += stat.size;
        } else {
          breakdown.OTHER += stat.size;
        }
      }
    }
  }

  try { walk(outDir); } catch (e) {}
  routes.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
  allFiles.sort((a, b) => b.bytes - a.bytes);

  const fmtMB = (b) => (b / (1024 * 1024)).toFixed(2);
  return {
    totalMB: fmtMB(totalBytes),
    fileCount,
    routes,
    topFiles: allFiles.slice(0, 15),
    breakdownMB: {
      JS: fmtMB(breakdown.JS),
      CSS: fmtMB(breakdown.CSS),
      HTML: fmtMB(breakdown.HTML),
      LIB_WASM: fmtMB(breakdown.LIB_WASM),
      FONTS: fmtMB(breakdown.FONTS),
      IMAGES: fmtMB(breakdown.IMAGES)
    },
    outputFolderName: path.basename(outDir)
  };
}

function startOfflineStaticServer(outDir, customHeaderRules = []) {
  return new Promise((resolve, reject) => {
    if (sandboxState.previewServer) {
      try { sandboxState.previewServer.close(); } catch (e) {}
      sandboxState.previewServer = null;
    }

    const resolvedOutRoot = path.resolve(outDir);

    function tryListen(portToTry) {
      const srv = http.createServer((req, res) => {
        try {
          const parsedUrl = new URL(req.url, `http://127.0.0.1:${portToTry}`);
          let pathname = decodeURIComponent(parsedUrl.pathname).replace(/\0/g, '');

          let targetFile = path.resolve(outDir, '.' + pathname);

          if (!targetFile.startsWith(resolvedOutRoot)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('403 Forbidden');
          }

          if (fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()) {
            targetFile = path.join(targetFile, 'index.html');
          } else if (!path.extname(targetFile) && fs.existsSync(targetFile + '.html')) {
            targetFile = targetFile + '.html';
          } else if (!path.extname(targetFile) && fs.existsSync(path.join(targetFile, 'index.html'))) {
            targetFile = path.join(targetFile, 'index.html');
          }

          if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
            if (pathname !== '/favicon.ico' && !pathname.startsWith('/api/')) {
              const msg = `404 Missing File requested by page: ${pathname}`;
              sandboxState.buildHistory.runtimeErrors.push({
                ts: new Date().toLocaleTimeString('en-IN', { hour12: false }),
                kind: 'HTTP_404_MISSING',
                route: req.headers.referer || '/',
                message: msg,
                detail: pathname,
                stack: ''
              });
              sendLog(`[404 MISSING ASSET] ${pathname}`, 'stderr');
              sendStatus('runtime-issue', { count: sandboxState.buildHistory.runtimeErrors.length });
            }

            if (pathname.startsWith('/api/')) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ offlineStaticPreview: true }));
            }

            const custom404 = path.join(outDir, '404.html');
            if (fs.existsSync(custom404)) {
              res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
              return res.end(fs.readFileSync(custom404));
            }
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Route Not Found');
          }

          const ext = path.extname(targetFile).toLowerCase();
          const mime = MIME_TYPES[ext] || 'application/octet-stream';
          const simulatedHeaders = matchHeaderRulesForIframePreview(pathname, customHeaderRules);

          res.writeHead(200, {
            ...simulatedHeaders,
            'Content-Type': mime,
            'Cache-Control': 'no-store'
          });

          if (ext === '.html') {
            let htmlContent = fs.readFileSync(targetFile, 'utf-8');
            if (htmlContent.includes('</head>')) {
              htmlContent = htmlContent.replace('</head>', `${RUNTIME_TELEMETRY_SNIPPET}</head>`);
            } else {
              htmlContent = RUNTIME_TELEMETRY_SNIPPET + htmlContent;
            }
            return res.end(htmlContent);
          }

          fs.createReadStream(targetFile).pipe(res);
        } catch (err) {
          res.writeHead(500);
          res.end('Internal Sandbox Server Error');
        }
      });

      srv.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && portToTry < 8810) {
          tryListen(portToTry + 1);
        } else {
          reject(err);
        }
      });

      srv.listen(portToTry, '127.0.0.1', () => {
        sandboxState.previewPort = portToTry;
        sandboxState.previewServer = srv;
        resolve(portToTry);
      });
    }

    tryListen(sandboxState.previewPort);
  });
}

function syncProjectToSandboxIncremental(srcDir, destDir) {
  const EXCLUDE = new Set([
    'node_modules',
    '.git',
    '.astro',
    '.next',
    '.nuxt',
    'dist',
    'build',
    'out',
    '.wrangler',
    'admin-local',
    'dist-portable'
  ]);

  let copiedFiles = 0;
  let skippedFiles = 0;

  const { container } = sandboxState.getSandboxPathsFn(srcDir);
  fs.mkdirSync(container, { recursive: true });
  fs.writeFileSync(path.join(container, SENTINEL_FILENAME), 'LOCKED_DRYRUN_SANDBOX_CONTAINER', 'utf-8');

  function syncRecursive(curSrc, curDest, isRoot = false) {
    fs.mkdirSync(curDest, { recursive: true });
    const srcEntries = fs.readdirSync(curSrc, { withFileTypes: true });
    const srcNames = new Set(srcEntries.map((e) => e.name));

    const destEntries = fs.readdirSync(curDest, { withFileTypes: true });
    for (const dEntry of destEntries) {
      if (isRoot && EXCLUDE.has(dEntry.name)) continue;
      if (!srcNames.has(dEntry.name)) {
        try {
          fs.rmSync(path.join(curDest, dEntry.name), { recursive: true, force: true });
        } catch (e) {}
      }
    }

    for (const entry of srcEntries) {
      if (isRoot && EXCLUDE.has(entry.name)) continue;
      const sPath = path.join(curSrc, entry.name);
      const dPath = path.join(curDest, entry.name);

      if (entry.isDirectory()) {
        syncRecursive(sPath, dPath, false);
      } else if (entry.isFile()) {
        let shouldCopy = true;
        if (fs.existsSync(dPath)) {
          try {
            const sStat = fs.statSync(sPath);
            const dStat = fs.statSync(dPath);
            if (sStat.size === dStat.size && Math.abs(sStat.mtimeMs - dStat.mtimeMs) < 1000) {
              shouldCopy = false;
            }
          } catch (e) {}
        }
        if (shouldCopy) {
          fs.copyFileSync(sPath, dPath);
          const sStat = fs.statSync(sPath);
          try { fs.utimesSync(dPath, sStat.atime, sStat.mtime); } catch (e) {}
          copiedFiles++;
        } else {
          skippedFiles++;
        }
      }
    }
  }

  for (const outName of ['dist', 'build', 'out']) {
    const outPath = path.join(destDir, outName);
    if (fs.existsSync(outPath)) {
      try { fs.rmSync(outPath, { recursive: true, force: true }); } catch (e) {}
    }
  }

  syncRecursive(srcDir, destDir, true);
  return { copiedFiles, skippedFiles };
}

export function runCommandStreaming(cmdStr, cwdDir, channel = 'sandbox') {
  return new Promise((resolve) => {
    sandboxState.activeBuildProc = spawn('cmd.exe', ['/d', '/s', '/c', cmdStr], {
      cwd: cwdDir,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: '1',
        NEXT_TELEMETRY_DISABLED: '1',
        NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0'
      }
    });

    sandboxState.activeBuildProc.stdout.on('data', (chunk) => {
      chunk.toString().split(/\r?\n/).forEach((l) => {
        if (l.trim()) {
          const clean = stripAnsiCodes(l);
          const isExplicitErr = /\b(SyntaxError|TypeError|ReferenceError|Transform failed|Build failed|\[ERROR\])\b/i.test(clean);
          sendLog(clean, isExplicitErr ? 'error' : 'stdout', channel);
        }
      });
    });

    sandboxState.activeBuildProc.stderr.on('data', (chunk) => {
      chunk.toString().split(/\r?\n/).forEach((l) => {
        if (l.trim()) sendLog(l, 'stderr', channel);
      });
    });

    sandboxState.activeBuildProc.on('close', (code) => {
      sandboxState.activeBuildProc = null;
      resolve(code);
    });
  });
}

function extractCompilerErrorBlocks(logs) {
  const blocks = [];
  for (let i = 0; i < logs.length; i++) {
    const item = logs[i];
    if (item.type === 'stderr' || item.type === 'error') {
      const start = Math.max(0, i - 2);
      const end = Math.min(logs.length - 1, i + 6);
      const snippet = logs.slice(start, end + 1).map((x) => `[${x.ts}] ${x.text}`).join('\n');
      blocks.push(snippet);
      i = end;
    }
  }
  return blocks;
}

async function ensureEngineNodeModules(resolvedSrc, projSlug) {
  const srcNodeModules = path.join(resolvedSrc, 'node_modules');
  if (fs.existsSync(srcNodeModules)) {
    return srcNodeModules;
  }

  const { engineCacheDir } = sandboxState.getSandboxPathsFn(resolvedSrc);
  const srcPkgJson = path.join(resolvedSrc, 'package.json');
  const rawPkg = JSON.parse(fs.readFileSync(srcPkgJson, 'utf-8'));
  const projCacheDir = path.join(engineCacheDir, projSlug);
  const cachedNodeModules = path.join(projCacheDir, 'node_modules');
  const cachePkgJson = path.join(projCacheDir, 'package.json');

  fs.mkdirSync(projCacheDir, { recursive: true });

  const depCount =
    Object.keys(rawPkg.dependencies || {}).length +
    Object.keys(rawPkg.devDependencies || {}).length;

  // Zero-dependency static/Node projects do not need npm install!
  if (depCount === 0) {
    fs.mkdirSync(cachedNodeModules, { recursive: true });
    return cachedNodeModules;
  }

  const minimalPkg = {
    name: `${projSlug}-engine-cache`,
    private: true,
    type: rawPkg.type || 'module',
    dependencies: rawPkg.dependencies || {},
    devDependencies: rawPkg.devDependencies || {}
  };

  const newPkgString = JSON.stringify(minimalPkg, null, 2);
  let depsChanged = true;
  if (fs.existsSync(cachePkgJson)) {
    try {
      depsChanged = fs.readFileSync(cachePkgJson, 'utf-8') !== newPkgString;
    } catch (e) {}
  }

  fs.writeFileSync(cachePkgJson, newPkgString, 'utf-8');

  if (!fs.existsSync(cachedNodeModules) || depsChanged) {
    sendLog(`[ENGINE CACHE] Installing project packages in isolated cache (${projCacheDir}) ...`, 'cmd');
    const code = await runCommandStreaming('npm install --no-audit --no-fund', projCacheDir);
    if (code !== 0) {
      throw new Error(`Failed to initialize packages in ${projCacheDir} (Exit code ${code}).`);
    }
    fs.mkdirSync(cachedNodeModules, { recursive: true });
    sendLog(`[SUCCESS] Package cache initialized.`, 'success');
  }

  return cachedNodeModules;
}

export async function runSandboxBuild(sourceDir, isRebuild = false) {
  if (sandboxState.isBuilding) return;
  if (!sourceDir || !sourceDir.trim()) {
    sendLog(`[ERROR] Please select or drop a project repository folder first.`, 'error');
    sendStatus('error', { message: 'Project folder path is empty.' });
    return;
  }

  const resolvedSrc = path.resolve(sourceDir.trim());
  sandboxState.currentSourceDir = resolvedSrc;
  const { workDir } = sandboxState.getSandboxPathsFn(resolvedSrc);
  const safety = validateSandboxPathSafety(workDir, resolvedSrc);
  if (!safety.valid) {
    sendLog(`[SAFETY BLOCK] ${safety.reason}`, 'error');
    sendStatus('error', { message: safety.reason });
    return;
  }

  sandboxState.isBuilding = true;
  const startTime = Date.now();

  try {
    const pkgJsonPath = path.join(resolvedSrc, 'package.json');

    if (!fs.existsSync(pkgJsonPath)) {
      sendLog(`[ERROR] No package.json found in: ${resolvedSrc}`, 'error');
      sendStatus('error', { message: 'Invalid project folder (missing package.json).' });
      sandboxState.isBuilding = false;
      return;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const projSlug = String(pkg.name || path.basename(resolvedSrc)).replace(/[^a-zA-Z0-9_-]/g, '_');
    sandboxState.currentProjectSlug = projSlug;

    let repoProfile = null;
    if (typeof sandboxState.onRepoTestedCallback === 'function') {
      repoProfile = sandboxState.onRepoTestedCallback(resolvedSrc);
    }

    sandboxState.buildHistory = {
      ...sandboxState.buildHistory,
      projectName: pkg.name || path.basename(resolvedSrc),
      projectSlug: projSlug,
      framework: detectFrameworkBadge(pkg),
      sourceDir: resolvedSrc,
      startTimeIso: new Date().toISOString(),
      durationSec: '0.0',
      status: 'BUILDING',
      exitCode: null,
      baselineExisted: false,
      logs: [],
      compilerErrorBlocks: [],
      runtimeErrors: [],
      preflightIssues: [],
      changedFiles: [],
      smokeTest: null,
      customHeadersLoaded: 0,
      audit: null
    };

    sendStatus('building', { sourceDir: resolvedSrc, repoProfile });
    sendLog(`================================================================`, 'cmd');
    sendLog(`DRY RUN STUDIO v${STUDIO_VERSION} — ${STUDIO_COPYRIGHT}`, 'cmd');
    sendLog(`PROJECT     : ${sandboxState.buildHistory.projectName} (${sandboxState.buildHistory.framework})`, 'cmd');
    sendLog(`SOURCE REPO : ${resolvedSrc} (100% Read-Only Protection)`, 'info');
    sendLog(`SANDBOX DIR : ${workDir}`, 'info');
    sendLog(`================================================================`, 'cmd');

    const canIncremental = isRebuild && sandboxState.lastSyncedSourceDir === resolvedSrc && fs.existsSync(workDir);

    if (!canIncremental) {
      sendLog(`[1/6] Preparing isolated sandbox workspace...`, 'info');
      wipeSandboxDirectory(false, false);
    } else {
      sendLog(`[1/6] Running fast incremental file sync...`, 'info');
    }

    const targetNodeModules = await ensureEngineNodeModules(resolvedSrc, projSlug);

    sendLog(`[2/6] Synchronizing source files to sandbox...`, 'info');
    const syncStats = syncProjectToSandboxIncremental(resolvedSrc, workDir);
    sandboxState.lastSyncedSourceDir = resolvedSrc;
    sendLog(`      -> Synced ${syncStats.copiedFiles} modified/new files (${syncStats.skippedFiles} unchanged files cached).`, 'info');

    const diffComparison = compareDirectoryAgainstRollingBaseline(workDir, projSlug);
    sandboxState.buildHistory.baselineExisted = diffComparison.baselineExisted;
    sandboxState.buildHistory.changedFiles = diffComparison.changes;

    if (!diffComparison.baselineExisted) {
      sendLog(`      -> [BASELINE] Creating initial rolling baseline snapshot for "${projSlug}"...`, 'info');
      saveDirectoryAsRollingBaseline(workDir, projSlug);
    } else {
      sendLog(`      -> [BASELINE] Compared against rolling baseline: ${diffComparison.changes.length} file(s) modified.`, 'info');
    }

    sendLog(`[3/6] Running Pre-Flight Security & Syntax Guard...`, 'info');
    const preflightIssues = runPreflightGuardOnSandbox(workDir);
    sandboxState.buildHistory.preflightIssues = preflightIssues;
    if (preflightIssues.length === 0) {
      sendLog(`      -> Pre-Flight Guard Passed (0 conflict markers or exposed secrets).`, 'info');
    } else {
      preflightIssues.forEach((iss) => {
        sendLog(`      -> [PREFLIGHT ${iss.severity}] ${iss.rule} in ${iss.file}:${iss.line}`, 'stderr');
      });
    }

    const sandboxNodeModules = path.join(workDir, 'node_modules');
    if (!fs.existsSync(sandboxNodeModules)) {
      sendLog(`[4/6] Mounting package cache via directory junction...`, 'info');
      execSync(`mklink /J "${sandboxNodeModules}" "${targetNodeModules}"`, { stdio: 'ignore' });
    } else {
      sendLog(`[4/6] Package junction active.`, 'info');
    }

    sendLog(`[5/6] Executing production build (npm run build)...`, 'cmd');
    const code = await runCommandStreaming('npm run build', workDir);

    sandboxState.isBuilding = false;
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    sandboxState.buildHistory.durationSec = durationSec;
    sandboxState.buildHistory.exitCode = code;
    sandboxState.buildHistory.compilerErrorBlocks = extractCompilerErrorBlocks(sandboxState.buildHistory.logs);

    if (code !== 0) {
      sandboxState.buildHistory.status = 'FAILED';
      sendLog(`\n[BUILD FAILED] Exited with code ${code} after ${durationSec}s. Export the .md Report for full diagnostics.`, 'error');
      sendStatus('error', { message: `Build failed (exit code ${code})` });
      return;
    }

    const outDir = locateBuildOutputDir(workDir);
    if (!outDir) {
      sandboxState.buildHistory.status = 'FAILED_NO_OUTPUT';
      sendLog(`[ERROR] Build finished, but no static output folder (dist/, build/, or out/) was generated.`, 'error');
      sendStatus('error', { message: 'Output folder missing after build.' });
      return;
    }

    sendLog(`[6/6] Running route & asset integrity smoke test on ${path.basename(outDir)}/...`, 'info');
    const smokeTest = runStaticSmokeTest(outDir);
    sandboxState.buildHistory.smokeTest = smokeTest;
    if (smokeTest.brokenLinks.length === 0) {
      sendLog(`      -> Smoke Test Passed: ${smokeTest.routesChecked} HTML routes & ${smokeTest.assetsVerified} local assets verified.`, 'info');
    } else {
      smokeTest.brokenLinks.forEach((bl) => {
        sendLog(`      -> [BROKEN ASSET LINK] Page "${bl.page}" references missing "${bl.missingRef}"`, 'stderr');
      });
    }

    const customHeaderRules = parseCloudflareHeadersFile(outDir);
    sandboxState.buildHistory.customHeadersLoaded = customHeaderRules.length;

    const audit = auditOutputDirectory(outDir);
    sandboxState.buildHistory.status = 'SUCCESS';
    sandboxState.buildHistory.audit = audit;

    const activePreviewPort = await startOfflineStaticServer(outDir, customHeaderRules);
    sendLog(`\n[SUCCESS] Dry Run Complete in ${durationSec}s! (${audit.routes.length} routes, ${audit.totalMB} MB)`, 'success');
    sendStatus('ready', {
      previewUrl: `http://127.0.0.1:${activePreviewPort}`,
      durationSec,
      audit,
      smokeTest,
      changedCount: sandboxState.buildHistory.changedFiles.length,
      preflightCount: preflightIssues.length,
      projectName: sandboxState.buildHistory.projectName,
      repoProfile
    });
  } catch (err) {
    sandboxState.isBuilding = false;
    sandboxState.buildHistory.status = 'CRITICAL_ERROR';
    sendLog(`[CRITICAL ERROR] ${err.stack || err.message}`, 'error');
    sandboxState.buildHistory.compilerErrorBlocks = extractCompilerErrorBlocks(buildHistory.logs);
    sendStatus('error', { message: err.message });
  }
}

export function generateMarkdownReport() {
  const h = sandboxState.buildHistory;
  const errorLines = h.logs.filter((l) => l.type === 'stderr' || l.type === 'error');
  const brokenCount = h.smokeTest ? h.smokeTest.brokenLinks.length : 0;
  const cfFailed = h.lastCloudflareDeployment && h.lastCloudflareDeployment.status === 'FAILED' ? 1 : 0;
  const totalIssues = errorLines.length + h.runtimeErrors.length + brokenCount + h.preflightIssues.length + cfFailed;
  const lines = [];

  lines.push(`# ⚡ ${STUDIO_BRAND} v${STUDIO_VERSION} — Diagnostic Report`);
  lines.push(`> *Check it on localhost before it goes to cloud.* • **${STUDIO_COPYRIGHT}**`);
  lines.push(``);

  lines.push(`## 🚨 1. Priority Error & Diagnostic Summary (${totalIssues} Issue(s))`);
  if (totalIssues === 0 && h.status === 'SUCCESS') {
    lines.push(`✅ **ALL CHECKS PASSED:** Build succeeded (\`Exit Code 0\`), Pre-Flight Guard passed, Static Smoke Test passed (\`0\` broken links), and Live Preview recorded \`0\` runtime JS/404 errors.`);
  } else {
    if (h.status !== 'SUCCESS' && h.status !== 'IDLE') {
      lines.push(`- ❌ **Local Build Status:** **${h.status}** (Exit Code: \`${h.exitCode}\`)`);
    }
    if (cfFailed) {
      lines.push(`- ❌ **Cloudflare Deployment Failed:** Project \`${h.lastCloudflareDeployment.projectName}\` (Deployment ID: \`${h.lastCloudflareDeployment.id}\`, Stage: \`${h.lastCloudflareDeployment.failedStage}\`)`);
    }
    if (h.compilerErrorBlocks.length > 0) {
      lines.push(`### Compiler / Build Error Context Blocks:`);
      h.compilerErrorBlocks.forEach((blk, idx) => {
        lines.push(`**Error Block #${idx + 1}:**`);
        lines.push('```text');
        lines.push(blk);
        lines.push('```');
      });
    }
    if (cfFailed && h.lastCloudflareDeployment.logs.length > 0) {
      lines.push(`### Failed Cloudflare Pages Build Log (Last ${h.lastCloudflareDeployment.logs.length} lines):`);
      lines.push('```text');
      h.lastCloudflareDeployment.logs.forEach((l) => lines.push(l));
      lines.push('```');
    }
    if (h.runtimeErrors.length > 0) {
      lines.push(`### Live Preview Runtime Exceptions & 404 Assets (${h.runtimeErrors.length}):`);
      h.runtimeErrors.forEach((re) => {
        lines.push(`- **[${re.ts}] \`${re.kind}\` on \`${re.route}\`:** ${re.message} ${re.detail ? `(\`${re.detail}\`)` : ''}`);
        if (re.stack) {
          lines.push('  ```text');
          lines.push('  ' + re.stack.split(/\r?\n/).slice(0, 6).join('\n  '));
          lines.push('  ```');
        }
      });
    }
    if (brokenCount > 0) {
      lines.push(`### Broken Static Asset Links (${brokenCount}):`);
      h.smokeTest.brokenLinks.forEach((bl) => {
        lines.push(`- Page \`${bl.page}\` $\\rightarrow$ Missing \`${bl.missingRef}\``);
      });
    }
    if (h.preflightIssues.length > 0) {
      lines.push(`### Pre-Flight Guard Alerts (${h.preflightIssues.length}):`);
      h.preflightIssues.forEach((pi) => {
        lines.push(`- **[${pi.severity}]** ${pi.rule} in \`${pi.file}:${pi.line}\``);
      });
    }
  }
  lines.push(``);

  const { container } = sandboxState.getSandboxPathsFn(h.sourceDir);
  lines.push(`## 2. Environment & Build Metadata`);
  lines.push(`| Property | Value |`);
  lines.push(`| :--- | :--- |`);
  lines.push(`| **Project Name** | \`${h.projectName || 'Unknown'}\` |`);
  lines.push(`| **Detected Stack** | \`${h.framework || 'Unknown'}\` |`);
  lines.push(`| **Local Build Status** | **${h.status}** (Exit Code: \`${h.exitCode !== null ? h.exitCode : 'N/A'}\`, Duration: \`${h.durationSec}s\`) |`);
  lines.push(`| **Sandbox Workspace** | \`${container}\` (Read-Only Source Protection) |`);
  lines.push(`| **Node.js Version** | \`${process.version}\` (${process.platform} ${process.arch}) |`);
  if (h.audit) {
    lines.push(`| **Output Bundle Size** | \`${h.audit.totalMB} MB\` across \`${h.audit.fileCount}\` files (\`${h.audit.routes.length}\` HTML routes) |`);
  }
  lines.push(``);

  lines.push(`## 3. Rolling Baseline Changes (${h.changedFiles.length} File(s) Modified)`);
  if (h.changedFiles.length === 0) {
    lines.push(`*No file changes compared to saved rolling baseline.*`);
  } else {
    lines.push(`| Status | File Path | Size (KB) |`);
    lines.push(`| :--- | :--- | :--- |`);
    h.changedFiles.forEach((cf) => {
      lines.push(`| **${cf.status}** | \`${cf.file}\` | \`${cf.sizeKB} KB\` |`);
    });
    lines.push(``);

    const diffableFiles = h.changedFiles.filter((c) => c.canDiff && c.status === 'MODIFIED').slice(0, 5);
    if (diffableFiles.length > 0) {
      lines.push(`<details>`);
      lines.push(`<summary><strong>Line-by-Line Code Diffs (${diffableFiles.length} Modified File(s))</strong></summary>`);
      lines.push(``);
      diffableFiles.forEach((df) => {
        lines.push(`### \`${df.file}\``);
        lines.push('```diff');
        const hunks = computeLineByLineDiff(df.file, h.projectSlug).slice(0, 80);
        hunks.forEach((hk) => {
          if (hk.type === 'add') lines.push(`+ [L${hk.newLn}] ${hk.text}`);
          else if (hk.type === 'del') lines.push(`- [L${hk.oldLn}] ${hk.text}`);
          else if (hk.type === 'sep') lines.push(`@@ ... @@`);
          else if (hk.type === 'same') lines.push(`  [L${hk.newLn}] ${hk.text}`);
        });
        lines.push('```');
      });
      lines.push(`</details>`);
    }
  }
  lines.push(``);

  lines.push(`## 4. Complete Session Log (${h.logs.length} lines)`);
  lines.push('```text');
  h.logs.forEach((l) => {
    lines.push(`[${l.ts}] [${l.channel.toUpperCase()}] ${l.text}`);
  });
  lines.push('```');
  lines.push(``);

  return lines.join('\n');
}

export function openModernWindowsFolderPicker(initialDir, dialogTitle = 'Select Folder', fallbackRoot = process.cwd()) {
  return new Promise((resolve) => {
    const startDir = initialDir && fs.existsSync(initialDir) ? initialDir : fallbackRoot;
    const safeInit = startDir.replace(/'/g, "''");
    const safeTitle = String(dialogTitle).replace(/"/g, '');

    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
internal class FileOpenDialogInternal {}

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileOpenDialog {
    [PreserveSig] int Show([In] IntPtr parent);
    void SetFileTypes();
    void SetFileTypeIndex();
    void GetFileTypeIndex();
    void Advise();
    void Unadvise();
    void SetOptions([In] uint fos);
    void GetOptions();
    void SetDefaultFolder([In, MarshalAs(UnmanagedType.Interface)] IShellItem psi);
    void SetFolder([In, MarshalAs(UnmanagedType.Interface)] IShellItem psi);
    void GetFolder();
    void GetCurrentSelection();
    void SetFileName();
    void GetFileName();
    void SetTitle([In, MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([In, MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel();
    void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem {
    void BindToHandler();
    void GetParent();
    void GetDisplayName([In] uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
}

public class ModernFolderPicker {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [In] string pszPath,
        [In] IntPtr pbc,
        [In, MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        [Out, MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    public static string Pick(string startPath) {
        IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogInternal();
        dialog.SetOptions(0x20 | 0x40);
        dialog.SetTitle("${safeTitle}");
        dialog.SetOkButtonLabel("Select Folder");
        try {
            IShellItem startItem;
            SHCreateItemFromParsingName(startPath, IntPtr.Zero, typeof(IShellItem).GUID, out startItem);
            dialog.SetFolder(startItem);
        } catch {}
        int hr = dialog.Show(IntPtr.Zero);
        if (hr != 0) return "";
        IShellItem resultItem;
        dialog.GetResult(out resultItem);
        string selectedPath;
        resultItem.GetDisplayName(0x80058000, out selectedPath);
        return selectedPath;
    }
}
"@
[ModernFolderPicker]::Pick('${safeInit}')
`;

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -Sta -EncodedCommand ${encoded}`, (err, stdout) => {
      if (err) return resolve('');
      resolve((stdout || '').trim());
    });
  });
}

export function createWindowsShortcuts({ targetBatPath, workingDir, createDesktop = true, createStartMenu = true }) {
  return new Promise((resolve) => {
    if (!targetBatPath || !fs.existsSync(targetBatPath)) {
      return resolve({ ok: false, error: 'Launcher script not found for shortcut creation.' });
    }
    const safeTarget = targetBatPath.replace(/'/g, "''");
    const safeWork = (workingDir || path.dirname(targetBatPath)).replace(/'/g, "''");

    const ps = `
      $wsh = New-Object -ComObject WScript.Shell;
      $created = @();
      if ($${createDesktop ? 'true' : 'false'}) {
        $desk = [Environment]::GetFolderPath('Desktop');
        $lnkPath = Join-Path $desk 'Dry Run Studio.lnk';
        $s = $wsh.CreateShortcut($lnkPath);
        $s.TargetPath = '${safeTarget}';
        $s.WorkingDirectory = '${safeWork}';
        $s.Description = 'Dry Run Studio v1.0.0 — Check it on localhost before it goes to cloud (by SRP Hub)';
        $s.IconLocation = 'shell32.dll,238';
        $s.Save();
        $created += 'Desktop';
      }
      if ($${createStartMenu ? 'true' : 'false'}) {
        $start = [Environment]::GetFolderPath('Programs');
        $lnkPath2 = Join-Path $start 'Dry Run Studio.lnk';
        $s2 = $wsh.CreateShortcut($lnkPath2);
        $s2.TargetPath = '${safeTarget}';
        $s2.WorkingDirectory = '${safeWork}';
        $s2.Description = 'Dry Run Studio v1.0.0 — Check it on localhost before it goes to cloud (by SRP Hub)';
        $s2.IconLocation = 'shell32.dll,238';
        $s2.Save();
        $created += 'Start Menu';
      }
      Write-Output ($created -join ', ')
    `.replace(/\r?\n/g, ' ');

    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      resolve({ ok: true, created: (stdout || '').trim() });
    });
  });
}