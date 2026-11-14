// File: src/server.mjs
// Dry Run Studio v1.0.0 — Check it on localhost before it goes to cloud.
// © 2026 SRP Hub (https://srphub.in) • MIT Open-Source License

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  STUDIO_VERSION,
  DEFAULT_SYSTEM_SANDBOX,
  sandboxState,
  initSandboxEngine,
  sendLog,
  sendStatus,
  validateSandboxPathSafety,
  detectFrameworkBadge,
  configureFileWatcher,
  saveDirectoryAsRollingBaseline,
  computeLineByLineDiff,
  wipeSandboxDirectory,
  runSandboxBuild,
  generateMarkdownReport,
  openModernWindowsFolderPicker,
  createWindowsShortcuts
} from './sandbox-engine.mjs';

import {
  masterVault,
  saveEncryptedVault,
  getRepoProfile,
  upsertRepoProfile,
  getSandboxPaths,
  checkGitEnvironmentStatus,
  configureGitGlobalAuthor,
  installGitViaWinget,
  initGitRepositoryIfNeeded,
  inspectGitRepositoryAndProfile,
  executeGitPushWorkflow,
  stopCloudflareLivePoller,
  cfApiRequest,
  startCloudflareLivePoller
} from './cloud-deployer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE_SCAN_ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const PORTABLE_SELF_BAT = process.argv[3] ? path.resolve(process.argv[3]) : '';
const MAX_BODY_BYTES = 256 * 1024;

let STUDIO_PORT = 49152;
let appBrowserProc = null;

initSandboxEngine({
  getSandboxPathsFn: getSandboxPaths,
  onRepoTestedCallback: (resolvedSrc) => {
    return upsertRepoProfile(resolvedSrc, {
      lastTestedIso: new Date().toISOString()
    });
  }
});

if (masterVault.globalSettings.lastActiveRepoPath) {
  sandboxState.currentSourceDir = masterVault.globalSettings.lastActiveRepoPath;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload exceeds maximum size limit (256KB)'));
        return;
      }
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Malformed JSON request'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function discoverAllKnownProjects() {
  const projects = [];
  const seen = new Set();

  function inspectCandidate(dirPath) {
    try {
      if (!dirPath) return;
      const resolved = path.resolve(dirPath);
      const lower = resolved.toLowerCase();
      if (seen.has(lower)) return;
      const pkgPath = path.join(resolved, 'package.json');
      if (!fs.existsSync(pkgPath) || !fs.statSync(pkgPath).isFile()) return;

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (!pkg.scripts || !pkg.scripts.build) return;

      seen.add(lower);
      const stat = fs.statSync(pkgPath);
      const slug = String(pkg.name || path.basename(resolved)).replace(/[^a-zA-Z0-9_-]/g, '_');
      const { lastStateDir } = getSandboxPaths(resolved);
      const hasRollingBaseline = fs.existsSync(path.join(lastStateDir, slug, '__binary_manifest__.json'));
      const profile = getRepoProfile(resolved, false);

      projects.push({
        folderName: path.basename(resolved),
        pkgName: pkg.name || path.basename(resolved),
        version: pkg.version || '1.0.0',
        framework: detectFrameworkBadge(pkg),
        fullPath: resolved,
        hasRollingBaseline,
        hasCloudProfile: Boolean(profile && profile.hasCfCredentials),
        modifiedMs: stat.mtimeMs
      });
    } catch (e) {}
  }

  for (const savedRepo of Object.values(masterVault.repositories || {})) {
    if (savedRepo && savedRepo.repoPath) {
      inspectCandidate(savedRepo.repoPath);
    }
  }

  try {
    inspectCandidate(WORKSPACE_SCAN_ROOT);
    const parentRoot = path.resolve(WORKSPACE_SCAN_ROOT, '..');
    inspectCandidate(parentRoot);

    for (const scanBase of [WORKSPACE_SCAN_ROOT, parentRoot]) {
      if (!fs.existsSync(scanBase)) continue;
      const level1 = fs.readdirSync(scanBase, { withFileTypes: true });
      for (const item of level1) {
        if (!item.isDirectory() || item.name.startsWith('.') || item.name === 'node_modules') continue;
        const sub1 = path.join(scanBase, item.name);
        inspectCandidate(sub1);
      }
    }
  } catch (e) {}

  projects.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return projects;
}

function launchMaximizedStudioApp(studioUrl) {
  const { browserProfileDir } = getSandboxPaths(sandboxState.currentSourceDir);
  try { fs.mkdirSync(browserProfileDir, { recursive: true }); } catch (e) {}

  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];

  const browserExe = [...edgePaths, ...chromePaths].find((p) => fs.existsSync(p));

  const args = [
    `--app=${studioUrl}`,
    `--user-data-dir=${browserProfileDir}`,
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync'
  ];

  if (browserExe) {
    appBrowserProc = spawn(browserExe, args, { detached: true, stdio: 'ignore' });
    appBrowserProc.unref();
  } else {
    exec(`start "" "${studioUrl}"`);
  }
}

function closeDedicatedBrowserWindow() {
  if (appBrowserProc && appBrowserProc.pid) {
    try { execSync(`taskkill /pid ${appBrowserProc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    appBrowserProc = null;
  }
  try {
    const psKill = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and ($_.CommandLine -like '*127.0.0.1:${STUDIO_PORT}*' -or $_.CommandLine -like '*_browser_ui_state*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${psKill}"`, { stdio: 'ignore' });
  } catch (e) {}
}

const studioServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${STUDIO_PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const uiPath = path.join(__dirname, 'ui.html');
      const html = fs.readFileSync(uiPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/init') {
      const projects = discoverAllKnownProjects();
      const gitEnv = await checkGitEnvironmentStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        version: STUDIO_VERSION,
        globalSettings: masterVault.globalSettings,
        defaultDocsSandbox: DEFAULT_SYSTEM_SANDBOX,
        projects,
        gitEnv
      }));
    }

    if (req.method === 'POST' && url.pathname === '/api/config-sandbox') {
      const parsed = await readJsonBody(req);
      const candidate = String(parsed.sandboxBaseDir || '').trim();
      const check = validateSandboxPathSafety(candidate, sandboxState.currentSourceDir);
      if (!check.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: check.reason }));
      }

      masterVault.globalSettings.sandboxBaseDir = check.resolved;
      masterVault.globalSettings.firstTimeSetupDone = true;
      saveEncryptedVault(masterVault);

      let shortcutsResult = null;
      if (parsed.createDesktopShortcut || parsed.createStartMenuShortcut) {
        const launcherCandidate = PORTABLE_SELF_BAT && fs.existsSync(PORTABLE_SELF_BAT)
          ? PORTABLE_SELF_BAT
          : path.resolve(__dirname, '..', 'Launch-Studio.bat');

        shortcutsResult = await createWindowsShortcuts({
          targetBatPath: launcherCandidate,
          workingDir: path.dirname(launcherCandidate),
          createDesktop: Boolean(parsed.createDesktopShortcut),
          createStartMenu: Boolean(parsed.createStartMenuShortcut)
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        sandboxBaseDir: check.resolved,
        shortcutsResult
      }));
    }

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const projects = discoverAllKnownProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ projects }));
    }

    if (req.method === 'POST' && url.pathname === '/api/repo-profile') {
      const parsed = await readJsonBody(req);
      if (!parsed.repoPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing repository path.' }));
      }
      if (parsed.sandboxOverrideDir) {
        const sCheck = validateSandboxPathSafety(parsed.sandboxOverrideDir, parsed.repoPath);
        if (!sCheck.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: sCheck.reason }));
        }
      }
      const updated = upsertRepoProfile(parsed.repoPath, {
        gitRemoteName: parsed.gitRemoteName || 'origin',
        gitBranch: parsed.gitBranch || 'main',
        gitRemoteUrl: parsed.gitRemoteUrl || '',
        gitPatToken: parsed.gitPatToken,
        cfAccountId: String(parsed.cfAccountId || '').trim().replace(/[^a-fA-F0-9]/g, ''),
        cfProjectName: String(parsed.cfProjectName || '').trim().replace(/[^a-zA-Z0-9_-]/g, ''),
        cfApiToken: parsed.cfApiToken,
        sandboxOverrideDir: parsed.sandboxOverrideDir || ''
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, profile: updated }));
    }

    if (req.method === 'GET' && url.pathname === '/api/git-env') {
      const gitEnv = await checkGitEnvironmentStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(gitEnv));
    }

    if (req.method === 'POST' && url.pathname === '/api/git-config-author') {
      const parsed = await readJsonBody(req);
      const result = await configureGitGlobalAuthor(parsed);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }

    if (req.method === 'POST' && url.pathname === '/api/git-install') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true }));
      installGitViaWinget();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/git-init') {
      const parsed = await readJsonBody(req);
      const info = await initGitRepositoryIfNeeded(
        parsed.repoDir || sandboxState.currentSourceDir,
        parsed.branch || 'main',
        parsed.remoteName || 'origin',
        parsed.remoteUrl || ''
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(info));
    }

    if (req.method === 'GET' && url.pathname === '/api/diff') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ changedFiles: sandboxState.buildHistory.changedFiles || [] }));
    }

    if (req.method === 'GET' && url.pathname === '/api/file-diff') {
      const relFile = url.searchParams.get('file') || '';
      const hunks = sandboxState.currentProjectSlug
        ? computeLineByLineDiff(relFile, sandboxState.currentProjectSlug)
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ hunks }));
    }

    if (req.method === 'POST' && url.pathname === '/api/update-baseline') {
      const { workDir } = getSandboxPaths(sandboxState.currentSourceDir);
      const targetDir = fs.existsSync(workDir) ? workDir : sandboxState.currentSourceDir;
      const ok = saveDirectoryAsRollingBaseline(targetDir, sandboxState.currentProjectSlug);
      if (ok) sandboxState.buildHistory.changedFiles = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    }

    if (req.method === 'GET' && url.pathname === '/api/report.md') {
      const mdContent = generateMarkdownReport();
      const safeSlug = String(sandboxState.buildHistory.projectName || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `dryrun-report-${safeSlug}-${Date.now()}.md`;
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store'
      });
      return res.end(mdContent);
    }

    if (req.method === 'POST' && url.pathname === '/api/runtime-error') {
      const parsed = await readJsonBody(req);
      const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
      sandboxState.buildHistory.runtimeErrors.push({
        ts,
        kind: parsed.kind || 'RUNTIME_ERROR',
        route: parsed.route || '/',
        message: parsed.message || '',
        detail: parsed.detail || '',
        stack: parsed.stack || ''
      });
      sendLog(`[PREVIEW ${parsed.kind}] (${parsed.route}) ${parsed.message} ${parsed.detail || ''}`, 'error');
      sendStatus('runtime-issue', { count: sandboxState.buildHistory.runtimeErrors.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === 'POST' && url.pathname === '/api/toggle-watch') {
      const parsed = await readJsonBody(req);
      if (parsed.sourceDir) sandboxState.currentSourceDir = parsed.sourceDir;
      const active = configureFileWatcher(Boolean(parsed.enable), sandboxState.currentSourceDir);
      sendLog(`[AUTO-WATCH] File watcher ${active ? 'enabled' : 'disabled'}.`, 'info');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ active }));
    }

    if (req.method === 'POST' && url.pathname === '/api/resolve-folder-name') {
      const parsed = await readJsonBody(req);
      const targetName = String(parsed.folderName || '').toLowerCase();
      const projects = discoverAllKnownProjects();
      const match = projects.find((p) => p.folderName.toLowerCase() === targetName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ resolvedPath: match ? match.fullPath : '' }));
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      sandboxState.sseClients.push(res);
      req.on('close', () => {
        sandboxState.sseClients = sandboxState.sseClients.filter((c) => c !== res);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
      const parsed = await readJsonBody(req);
      const picked = await openModernWindowsFolderPicker(
        parsed.currentPath || sandboxState.currentSourceDir,
        parsed.title || 'Select Folder',
        WORKSPACE_SCAN_ROOT
      );
      if (picked && !parsed.title?.includes('Sandbox')) {
        sandboxState.currentSourceDir = picked;
        upsertRepoProfile(picked, {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ selectedPath: picked }));
    }

    if (req.method === 'POST' && url.pathname === '/api/build') {
      const parsed = await readJsonBody(req);
      if (parsed.sourceDir) sandboxState.currentSourceDir = parsed.sourceDir;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true }));
      runSandboxBuild(sandboxState.currentSourceDir, Boolean(parsed.isRebuild));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/git-inspect') {
      const parsed = await readJsonBody(req);
      const info = await inspectGitRepositoryAndProfile(parsed.repoDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(info));
    }

    if (req.method === 'POST' && url.pathname === '/api/git-push') {
      const parsed = await readJsonBody(req);
      const result = await executeGitPushWorkflow(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }

    if (req.method === 'POST' && url.pathname === '/api/cf-watch') {
      const parsed = await readJsonBody(req);
      const prof = getRepoProfile(parsed.repoDir || sandboxState.currentSourceDir, true);
      if (!prof || !prof.cfAccountId || !prof.cfApiToken || !prof.cfProjectName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Cloudflare credentials not configured for this repository.' }));
      }
      startCloudflareLivePoller(prof.cfAccountId, prof.cfProjectName, prof.cfApiToken, prof.repoPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === 'POST' && url.pathname === '/api/cf-retry') {
      const parsed = await readJsonBody(req);
      const prof = getRepoProfile(parsed.repoDir || sandboxState.currentSourceDir, true);
      const depId = String(parsed.deploymentId || '').trim();
      if (!prof || !prof.cfAccountId || !prof.cfApiToken || !prof.cfProjectName || !depId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing Cloudflare credentials or deployment ID.' }));
      }
      const retryUrl = `/client/v4/accounts/${encodeURIComponent(prof.cfAccountId)}/pages/projects/${encodeURIComponent(prof.cfProjectName)}/deployments/${encodeURIComponent(depId)}/retry`;
      const apiRes = await cfApiRequest('POST', retryUrl, prof.cfApiToken);
      if (apiRes.data && apiRes.data.success) {
        sendLog(`[CLOUDFLARE RETRY] Triggered retry deployment for ${prof.cfProjectName}!`, 'success', 'deploy');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } else {
        const msg = apiRes.data?.errors?.[0]?.message || 'Cloudflare retry failed';
        sendLog(`[CLOUDFLARE RETRY ERROR] ${msg}`, 'error', 'deploy');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: msg }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/wipe-exit') {
      const parsed = await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        wipeSandboxDirectory(Boolean(parsed.deleteEngineCacheToo), true, stopCloudflareLivePoller, closeDedicatedBrowserWindow);
        process.exit(0);
      }, 120);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

process.on('uncaughtException', (err) => {
  sendLog(`[ENGINE EXCEPTION] ${err.message}`, 'error');
});
process.on('unhandledRejection', (reason) => {
  sendLog(`[ENGINE PROMISE] ${String(reason)}`, 'error');
});
process.on('SIGINT', () => {
  wipeSandboxDirectory(false, true, stopCloudflareLivePoller, closeDedicatedBrowserWindow);
  process.exit(0);
});
process.on('SIGTERM', () => {
  wipeSandboxDirectory(false, true, stopCloudflareLivePoller, closeDedicatedBrowserWindow);
  process.exit(0);
});

function startStudioServer(portToTry) {
  studioServer.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && portToTry < 49170) {
      startStudioServer(portToTry + 1);
    }
  });
  studioServer.listen(portToTry, '127.0.0.1', () => {
    STUDIO_PORT = portToTry;
    const studioUrl = `http://127.0.0.1:${STUDIO_PORT}`;
    launchMaximizedStudioApp(studioUrl);
  });
}

startStudioServer(STUDIO_PORT);
