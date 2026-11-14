// File: src/cloud-deployer.mjs
// Dry Run Studio v1.0.0 — Check it on localhost before it goes to cloud.
// © 2026 SRP Hub (https://srphub.in) • MIT Open-Source License

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync, exec } from 'node:child_process';
import {
  DEFAULT_SYSTEM_SANDBOX,
  STUDIO_VERSION,
  sandboxState,
  stripAnsiCodes,
  sendLog,
  sendStatus,
  runPreflightGuardOnSandbox,
  promoteSourceToRollingBaseline
} from './sandbox-engine.mjs';

export const APPDATA_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'DryRunStudio'
);
export const ENCRYPTED_VAULT_FILE = path.join(APPDATA_DIR, 'projects-vault.dat');

fs.mkdirSync(APPDATA_DIR, { recursive: true });

let cfPollTimer = null;
let isDeploying = false;

// ============================================================================
// 1. WINDOWS DPAPI ENCRYPTION & MULTI-PROJECT VAULT
// ============================================================================

function dpapiEncryptString(plainText) {
  if (!plainText) return '';
  try {
    const b64In = Buffer.from(String(plainText), 'utf-8').toString('base64');
    const ps = `
      Add-Type -AssemblyName System.Security;
      $bytes = [Convert]::FromBase64String('${b64In}');
      $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
      [Convert]::ToBase64String($enc)
    `.replace(/\r?\n/g, ' ');
    return execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { encoding: 'utf-8' }).trim();
  } catch (e) {
    return '';
  }
}

function dpapiDecryptString(cipherB64) {
  if (!cipherB64) return '';
  try {
    const safeB64 = String(cipherB64).replace(/[^a-zA-Z0-9+/=]/g, '');
    const ps = `
      Add-Type -AssemblyName System.Security;
      $enc = [Convert]::FromBase64String('${safeB64}');
      $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
      [System.Text.Encoding]::UTF8.GetString($dec)
    `.replace(/\r?\n/g, ' ');
    return execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { encoding: 'utf-8' }).trim();
  } catch (e) {
    return '';
  }
}

function createDefaultVaultState() {
  return {
    version: STUDIO_VERSION,
    globalSettings: {
      sandboxBaseDir: DEFAULT_SYSTEM_SANDBOX,
      firstTimeSetupDone: false,
      lastActiveRepoPath: ''
    },
    repositories: {}
  };
}

export function loadEncryptedVault() {
  try {
    if (!fs.existsSync(ENCRYPTED_VAULT_FILE)) {
      return createDefaultVaultState();
    }
    const cipherText = fs.readFileSync(ENCRYPTED_VAULT_FILE, 'utf-8').trim();
    if (!cipherText) return createDefaultVaultState();
    const jsonStr = dpapiDecryptString(cipherText);
    if (!jsonStr) return createDefaultVaultState();
    const parsed = JSON.parse(jsonStr);
    return {
      version: STUDIO_VERSION,
      globalSettings: {
        sandboxBaseDir: parsed.globalSettings?.sandboxBaseDir || DEFAULT_SYSTEM_SANDBOX,
        firstTimeSetupDone: Boolean(parsed.globalSettings?.firstTimeSetupDone),
        lastActiveRepoPath: parsed.globalSettings?.lastActiveRepoPath || ''
      },
      repositories: parsed.repositories || {}
    };
  } catch (e) {
    return createDefaultVaultState();
  }
}

export function saveEncryptedVault(vaultObj) {
  try {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    const plainJson = JSON.stringify(vaultObj);
    const encrypted = dpapiEncryptString(plainJson);
    if (encrypted) {
      fs.writeFileSync(ENCRYPTED_VAULT_FILE, encrypted, 'utf-8');
      return true;
    }
  } catch (e) {}
  return false;
}

export let masterVault = loadEncryptedVault();

function normalizeRepoKey(repoPath) {
  return path.resolve(String(repoPath || '').trim()).toLowerCase();
}

export function getRepoProfile(repoPath, includeSecrets = false) {
  if (!repoPath) return null;
  const key = normalizeRepoKey(repoPath);
  const resolved = path.resolve(repoPath);
  const existing = masterVault.repositories[key] || {};
  const folderName = path.basename(resolved);

  const profile = {
    repoPath: resolved,
    folderName,
    sandboxOverrideDir: existing.sandboxOverrideDir || '',
    gitRemoteName: existing.gitRemoteName || 'origin',
    gitRemoteUrl: existing.gitRemoteUrl || '',
    gitBranch: existing.gitBranch || '',
    hasGitPat: Boolean(existing.gitPatToken),
    cfAccountId: existing.cfAccountId || '',
    cfProjectName: existing.cfProjectName || folderName,
    hasCfCredentials: Boolean(existing.cfAccountId && existing.cfApiToken),
    lastTestedIso: existing.lastTestedIso || '',
    lastDeployedIso: existing.lastDeployedIso || ''
  };

  if (includeSecrets) {
    profile.gitPatToken = existing.gitPatToken || '';
    profile.cfApiToken = existing.cfApiToken || '';
  }

  return profile;
}

export function upsertRepoProfile(repoPath, updates) {
  if (!repoPath) return null;
  const key = normalizeRepoKey(repoPath);
  const current = getRepoProfile(repoPath, true);
  const merged = {
    ...current,
    ...updates,
    repoPath: path.resolve(repoPath)
  };

  if (updates.cfApiToken === undefined || updates.cfApiToken === '••••••••') {
    merged.cfApiToken = current.cfApiToken;
  }
  if (updates.gitPatToken === undefined || updates.gitPatToken === '••••••••') {
    merged.gitPatToken = current.gitPatToken;
  }

  masterVault.repositories[key] = merged;
  masterVault.globalSettings.lastActiveRepoPath = merged.repoPath;
  saveEncryptedVault(masterVault);
  return getRepoProfile(repoPath, false);
}

export function getSandboxPaths(activeRepoPath = '') {
  const prof = activeRepoPath ? getRepoProfile(activeRepoPath, false) : null;
  const rawBase = (prof && prof.sandboxOverrideDir)
    ? prof.sandboxOverrideDir
    : (masterVault.globalSettings.sandboxBaseDir || DEFAULT_SYSTEM_SANDBOX);
  const base = path.resolve(rawBase);

  const lower = base.toLowerCase();
  const container = (
    lower.endsWith('sandbox') ||
    lower.endsWith('testbuild') ||
    lower.endsWith('sandboxbuild') ||
    lower.endsWith('_dryrun_sandbox_workspace')
  )
    ? base
    : path.join(base, '_DryRun_Sandbox_Workspace');

  return {
    base,
    container,
    workDir: path.join(container, '_ephemeral_sandbox_run'),
    lastStateDir: path.join(container, '_last_state'),
    engineCacheDir: path.join(container, '_engine_cache'),
    browserProfileDir: path.join(container, '_browser_ui_state'),
    cfLogsDir: path.join(container, '_cloud_error_logs')
  };
}

// ============================================================================
// 2. GIT INSTALLATION, AUTHOR IDENTITY & AUTHENTICATION READINESS ENGINE
// ============================================================================

export function runGitSafe(argsArray, cwdDir, streamToDeployConsole = true, extraEnv = {}) {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const proc = spawn('git', argsArray, {
      cwd: cwdDir || process.cwd(),
      shell: false,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...extraEnv
      }
    });

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdoutBuf += s;
      if (streamToDeployConsole) {
        s.split(/\r?\n/).forEach((line) => {
          if (line.trim()) sendLog(line, 'stdout', 'deploy');
        });
      }
    });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      if (streamToDeployConsole) {
        s.split(/\r?\n/).forEach((line) => {
          if (line.trim()) sendLog(line, 'stderr', 'deploy');
        });
      }
    });

    proc.on('error', (err) => {
      resolve({ code: 1, stdout: stdoutBuf, stderr: err.message });
    });

    proc.on('close', (code) => {
      resolve({ code: code ?? 0, stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() });
    });
  });
}

// Checks if Git is installed on the user's PC and whether author user.name & user.email are configured
export async function checkGitEnvironmentStatus() {
  const verRes = await runGitSafe(['--version'], process.cwd(), false);
  if (verRes.code !== 0 || !verRes.stdout.toLowerCase().includes('git version')) {
    return {
      gitInstalled: false,
      version: '',
      userName: '',
      userEmail: '',
      credentialHelper: ''
    };
  }

  const nameRes = await runGitSafe(['config', '--global', 'user.name'], process.cwd(), false);
  const emailRes = await runGitSafe(['config', '--global', 'user.email'], process.cwd(), false);
  const helperRes = await runGitSafe(['config', 'credential.helper'], process.cwd(), false);

  return {
    gitInstalled: true,
    version: verRes.stdout.replace(/^git version\s*/i, '').trim(),
    userName: nameRes.stdout || '',
    userEmail: emailRes.stdout || '',
    credentialHelper: helperRes.stdout || 'manager'
  };
}

// Configures global Git author name & email for first-time PCs
export async function configureGitGlobalAuthor({ userName, userEmail }) {
  const cleanName = String(userName || '').trim();
  const cleanEmail = String(userEmail || '').trim();
  if (!cleanName || !cleanEmail) {
    return { ok: false, error: 'Both Git Author Name and Email are required.' };
  }
  await runGitSafe(['config', '--global', 'user.name', cleanName], process.cwd(), false);
  await runGitSafe(['config', '--global', 'user.email', cleanEmail], process.cwd(), false);
  await runGitSafe(['config', '--global', 'credential.helper', 'manager'], process.cwd(), false);
  sendLog(`[GIT SETUP] Configured global Git author: ${cleanName} <${cleanEmail}>`, 'success', 'deploy');
  return { ok: true, status: await checkGitEnvironmentStatus() };
}

// 1-Click Auto-Installer for Git for Windows via official winget package manager
export function installGitViaWinget() {
  return new Promise((resolve) => {
    sendLog(`[GIT INSTALLER] Launching official Git for Windows installation via winget...`, 'cmd', 'deploy');
    const proc = spawn('cmd.exe', [
      '/d', '/s', '/c',
      'winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements'
    ], { cwd: process.cwd() });

    proc.stdout.on('data', (c) => {
      c.toString().split(/\r?\n/).forEach((l) => {
        if (l.trim()) sendLog(l, 'stdout', 'deploy');
      });
    });
    proc.stderr.on('data', (c) => {
      c.toString().split(/\r?\n/).forEach((l) => {
        if (l.trim()) sendLog(l, 'stderr', 'deploy');
      });
    });
    proc.on('close', (code) => {
      if (code === 0) {
        sendLog(`[SUCCESS] Git for Windows installed! Restart Dry Run Studio if PATH requires refresh.`, 'success', 'deploy');
        resolve({ ok: true });
      } else {
        sendLog(`[NOTICE] Winget exited with code ${code}. Opening https://git-scm.com/download/win ...`, 'stderr', 'deploy');
        exec('start "" "https://git-scm.com/download/win"');
        resolve({ ok: false, code });
      }
    });
  });
}

// Initializes a new .git repository if the user wants to push a local project that isn't a Git repo yet
export async function initGitRepositoryIfNeeded(repoDir, branch = 'main', remoteName = 'origin', remoteUrl = '') {
  const resolved = path.resolve(repoDir);
  const gitDir = path.join(resolved, '.git');
  if (!fs.existsSync(gitDir)) {
    sendLog(`[GIT INIT] Initializing new Git repository in ${resolved}...`, 'info', 'deploy');
    await runGitSafe(['init', '-b', branch || 'main'], resolved, true);
  }
  if (remoteUrl && remoteUrl.trim()) {
    const remCheck = await runGitSafe(['remote'], resolved, false);
    const list = remCheck.stdout.split(/\r?\n/).map((s) => s.trim());
    if (list.includes(remoteName)) {
      await runGitSafe(['remote', 'set-url', remoteName, remoteUrl.trim()], resolved, false);
    } else {
      await runGitSafe(['remote', 'add', remoteName, remoteUrl.trim()], resolved, false);
    }
  }
  return inspectGitRepositoryAndProfile(resolved);
}

// ============================================================================
// 3. MULTI-REPO GIT INSPECTOR & PUSH WORKFLOW (WITH AUTO-BASELINE PROMOTION)
// ============================================================================

export async function inspectGitRepositoryAndProfile(repoDir) {
  const gitEnv = await checkGitEnvironmentStatus();
  if (!repoDir || !fs.existsSync(repoDir)) {
    return { isGit: false, gitEnv, error: 'Repository folder does not exist.' };
  }

  const resolved = path.resolve(repoDir);
  const profile = getRepoProfile(resolved, false);
  const gitFolder = path.join(resolved, '.git');

  if (!gitEnv.gitInstalled) {
    return {
      isGit: false,
      gitEnv,
      error: 'Git is not installed on this PC. Use the Git Setup button to install Git.',
      profile
    };
  }

  if (!fs.existsSync(gitFolder)) {
    return {
      isGit: false,
      gitEnv,
      error: 'No .git repository initialized in this project folder yet.',
      profile
    };
  }

  const branchRes = await runGitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], resolved, false);
  const remoteRes = await runGitSafe(['remote', '-v'], resolved, false);
  const statusRes = await runGitSafe(['status', '--porcelain'], resolved, false);
  const hasLockFile = fs.existsSync(path.join(gitFolder, 'index.lock'));

  const remotes = [];
  const seenRemotes = new Set();
  remoteRes.stdout.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(push\)/);
    if (m && !seenRemotes.has(m[1])) {
      seenRemotes.add(m[1]);
      // Strip any embedded credentials from display URL
      const cleanDisplayUrl = m[2].replace(/^https:\/\/[^@]+@/, 'https://');
      remotes.push({ name: m[1], url: cleanDisplayUrl });
    }
  });

  const detectedBranch = (branchRes.code === 0 && branchRes.stdout && branchRes.stdout !== 'HEAD')
    ? branchRes.stdout
    : (profile.gitBranch || 'main');
  const primaryRemote = remotes[0] || { name: 'origin', url: '' };

  const updatedProfile = upsertRepoProfile(resolved, {
    gitRemoteName: profile.gitRemoteName || primaryRemote.name,
    gitRemoteUrl: primaryRemote.url || profile.gitRemoteUrl,
    gitBranch: detectedBranch
  });

  const changedFiles = statusRes.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => ({
      code: l.slice(0, 2).trim(),
      file: l.slice(3).trim()
    }));

  return {
    isGit: true,
    gitEnv,
    branch: detectedBranch,
    remotes,
    changedFiles,
    hasLockFile,
    profile: updatedProfile
  };
}

export async function executeGitPushWorkflow({
  repoDir,
  remoteName = 'origin',
  remoteUrl = '',
  branch = '',
  commitMessage = 'Update and deploy',
  cleanLockFirst = false,
  autoPromoteBaseline = true
}) {
  if (isDeploying) return { ok: false, error: 'A deployment task is already running.' };
  isDeploying = true;

  try {
    const gitEnv = await checkGitEnvironmentStatus();
    if (!gitEnv.gitInstalled) {
      throw new Error('Git is not installed on this PC. Click "Git & Auth Setup" to install Git first.');
    }
    if (!gitEnv.userName || !gitEnv.userEmail) {
      throw new Error('Git Author Name and Email are not configured on this PC. Click "Git & Auth Setup" to set your author identity.');
    }

    const resolvedRepo = path.resolve(repoDir);
    const fullProfile = getRepoProfile(resolvedRepo, true);

    // If not initialized yet and user provided a remoteUrl, initialize automatically
    if (!fs.existsSync(path.join(resolvedRepo, '.git'))) {
      if (remoteUrl || fullProfile?.gitRemoteUrl) {
        await initGitRepositoryIfNeeded(
          resolvedRepo,
          branch || fullProfile?.gitBranch || 'main',
          remoteName,
          remoteUrl || fullProfile?.gitRemoteUrl
        );
      } else {
        throw new Error(`No .git repository found in ${resolvedRepo}. Configure a Git Remote URL in Project Cloud Profile first.`);
      }
    }

    sendLog(`================================================================`, 'cmd', 'deploy');
    sendLog(`GITHUB PUSH WORKFLOW: ${path.basename(resolvedRepo)}`, 'cmd', 'deploy');
    sendLog(`================================================================`, 'cmd', 'deploy');

    const lockFile = path.join(resolvedRepo, '.git', 'index.lock');
    if (cleanLockFirst && fs.existsSync(lockFile)) {
      sendLog(`[GIT RECOVERY] Removing stale .git/index.lock file...`, 'info', 'deploy');
      try { fs.unlinkSync(lockFile); } catch (e) {}
    }

    const effectiveRemoteUrl = (remoteUrl || fullProfile?.gitRemoteUrl || '').trim();
    if (effectiveRemoteUrl) {
      const checkRem = await runGitSafe(['remote'], resolvedRepo, false);
      const existingRemotes = checkRem.stdout.split(/\r?\n/).map((s) => s.trim());
      if (existingRemotes.includes(remoteName)) {
        await runGitSafe(['remote', 'set-url', remoteName, effectiveRemoteUrl], resolvedRepo, false);
      } else {
        await runGitSafe(['remote', 'add', remoteName, effectiveRemoteUrl], resolvedRepo, false);
      }
    }

    // Pre-Flight Security Guard before pushing to GitHub
    const secretIssues = runPreflightGuardOnSandbox(resolvedRepo).filter((i) => i.severity === 'HIGH');
    if (secretIssues.length > 0) {
      secretIssues.forEach((iss) => {
        sendLog(`[SECURITY BLOCK] ${iss.rule} detected in ${iss.file}:${iss.line}`, 'error', 'deploy');
      });
      throw new Error(`Push blocked by Pre-Flight Security Guard (${secretIssues.length} critical issue(s)).`);
    }

    sendLog(`[1/3] Staging repository changes (git add -A)...`, 'info', 'deploy');
    const addRes = await runGitSafe(['add', '-A'], resolvedRepo, true);
    if (addRes.code !== 0) {
      throw new Error(`git add failed: ${addRes.stderr}`);
    }

    const statusCheck = await runGitSafe(['status', '--porcelain'], resolvedRepo, false);
    if (statusCheck.stdout.length > 0) {
      const safeMsg = String(commitMessage || 'Update and deploy').trim().slice(0, 200);
      sendLog(`[2/3] Creating commit: "${safeMsg}"...`, 'info', 'deploy');
      const commitRes = await runGitSafe(['commit', '-m', safeMsg], resolvedRepo, true);
      if (commitRes.code !== 0) {
        throw new Error(`git commit failed: ${commitRes.stderr || commitRes.stdout}`);
      }
    } else {
      sendLog(`[2/3] Working tree clean — pushing existing commits...`, 'info', 'deploy');
    }

    const targetBranch = branch || fullProfile?.gitBranch || 'main';

    // If user stored a GitHub PAT in the encrypted vault for this repo, inject via transient HTTP header (never saved in .git/config!)
    let pushArgs = ['push', '-u', remoteName, targetBranch];
    if (fullProfile?.gitPatToken) {
      const basicAuth = Buffer.from(`x-access-token:${fullProfile.gitPatToken}`, 'utf-8').toString('base64');
      pushArgs = ['-c', `http.extraheader=AUTHORIZATION: basic ${basicAuth}`, 'push', '-u', remoteName, targetBranch];
    }

    sendLog(`[3/3] Pushing to GitHub (${remoteName} -> ${targetBranch})...`, 'cmd', 'deploy');
    // Allow interactive Git Credential Manager popup if no PAT is stored
    const pushRes = await runGitSafe(
      pushArgs,
      resolvedRepo,
      true,
      fullProfile?.gitPatToken ? { GIT_TERMINAL_PROMPT: '0' } : { GIT_TERMINAL_PROMPT: '1' }
    );

    if (pushRes.code !== 0) {
      throw new Error(`git push failed: ${pushRes.stderr || pushRes.stdout}`);
    }

    upsertRepoProfile(resolvedRepo, {
      gitRemoteName: remoteName,
      gitBranch: targetBranch,
      lastDeployedIso: new Date().toISOString()
    });

    sendLog(`[SUCCESS] Repository pushed to GitHub!`, 'success', 'deploy');

    // Automatically set current state as Rolling Baseline if requested (or when not waiting for Cloudflare)
    if (autoPromoteBaseline) {
      promoteSourceToRollingBaseline(resolvedRepo);
    }

    isDeploying = false;
    return { ok: true };
  } catch (err) {
    sendLog(`[GIT PUSH ERROR] ${err.message}`, 'error', 'deploy');
    isDeploying = false;
    return { ok: false, error: err.message };
  }
}

// ============================================================================
// 4. CLOUDFLARE PAGES LIVE STAGE TRACKER, RETRY API & AUTO-BASELINE PROMOTER
// ============================================================================

export function stopCloudflareLivePoller() {
  if (cfPollTimer) {
    clearInterval(cfPollTimer);
    cfPollTimer = null;
  }
}

export function cfApiRequest(method, apiPath, apiToken, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request({
      hostname: 'api.cloudflare.com',
      port: 443,
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      timeout: 15000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw || '{}');
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          reject(new Error(`Invalid response from Cloudflare API (HTTP ${res.statusCode})`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Cloudflare API request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function startCloudflareLivePoller(accountId, projectName, apiToken, repoDir = '') {
  stopCloudflareLivePoller();

  const displayedStages = new Set();
  const startTimeMs = Date.now();
  let pollInFlight = false;

  sendLog(`Connecting to Cloudflare Pages project "${projectName}" (Account: ${accountId.slice(0, 6)}...)...`, 'info', 'deploy');

  cfPollTimer = setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;

    try {
      const urlPath = `/client/v4/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments`;
      const resp = await cfApiRequest('GET', urlPath, apiToken);

      if (!resp.data || !resp.data.success || !Array.isArray(resp.data.result) || resp.data.result.length === 0) {
        const errMsg = resp.data?.errors?.[0]?.message || 'Unable to fetch deployments. Verify Account ID, Project Name, and Token.';
        sendLog(`[CLOUDFLARE API ERROR] ${errMsg}`, 'error', 'deploy');
        stopCloudflareLivePoller();
        pollInFlight = false;
        return;
      }

      const dep = resp.data.result[0];
      const stages = dep.stages || [];
      const currentStageName = dep.latest_stage?.name || 'queued';
      const currentStatus = dep.latest_stage?.status || 'active';

      const elapsedTotalSec = Math.floor((Date.now() - startTimeMs) / 1000);
      const mm = String(Math.floor(elapsedTotalSec / 60)).padStart(2, '0');
      const ss = String(elapsedTotalSec % 60).padStart(2, '0');
      const elapsedFormatted = `${mm}:${ss}`;

      for (const s of stages) {
        const sName = s.name;
        const sStarted = s.started_on;
        const sEnded = s.ended_on;

        if (sStarted && !displayedStages.has(sName)) {
          const istStart = new Date(sStarted).toLocaleTimeString('en-IN', { hour12: false });
          sendLog(`[${istStart}] Stage '${sName}' started...`, 'info', 'deploy');
          displayedStages.add(sName);
        }

        if (sEnded && !displayedStages.has(`${sName}-done`)) {
          const startDt = new Date(sStarted).getTime();
          const endDt = new Date(sEnded).getTime();
          const durSec = Math.max(0, Math.round((endDt - startDt) / 1000));
          const durFormatted = durSec >= 60 ? `${Math.floor(durSec / 60)}m ${durSec % 60}s` : `${durSec}s`;
          const istEnd = new Date(sEnded).toLocaleTimeString('en-IN', { hour12: false });
          sendLog(`[${istEnd}] Stage '${sName}' completed in ${durFormatted}`, 'success', 'deploy');
          displayedStages.add(`${sName}-done`);
        }
      }

      sendStatus('cf-progress', {
        deploymentId: dep.id,
        projectName,
        accountId,
        shortCommit: dep.deployment_trigger?.metadata?.commit_hash?.slice(0, 7) || '',
        commitMessage: dep.deployment_trigger?.metadata?.commit_message || '',
        stageName: currentStageName,
        stageStatus: currentStatus,
        elapsed: elapsedFormatted,
        url: dep.url || `https://${projectName}.pages.dev`,
        stages
      });

      if (currentStageName === 'deploy' && currentStatus === 'success') {
        stopCloudflareLivePoller();
        sandboxState.buildHistory.lastCloudflareDeployment = {
          id: dep.id,
          projectName,
          status: 'SUCCESS',
          elapsed: elapsedFormatted,
          url: dep.url,
          logs: []
        };
        sendLog(`SUCCESS: Cloudflare Deployment (${dep.id.slice(0, 8)}) live in ${elapsedFormatted}!`, 'success', 'deploy');

        // AUTOMATIC BASELINE PROMOTION ON CLOUD DEPLOY SUCCESS!
        if (repoDir) {
          promoteSourceToRollingBaseline(repoDir);
          upsertRepoProfile(repoDir, { lastDeployedIso: new Date().toISOString() });
        }

        sendStatus('cf-complete', { deploymentId: dep.id, url: dep.url, elapsed: elapsedFormatted });
      } else if (currentStatus === 'failure' || currentStatus === 'canceled') {
        stopCloudflareLivePoller();
        sendLog(`ERROR: Cloudflare Build ${currentStatus.toUpperCase()} at stage '${currentStageName}' (${elapsedFormatted}). Fetching failure log...`, 'error', 'deploy');

        const logUrlPath = `/client/v4/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(dep.id)}/history/logs`;
        try {
          const logResp = await cfApiRequest('GET', logUrlPath, apiToken);
          const logEntries = logResp.data?.result?.data || [];
          const formattedLines = logEntries.map((item) => `${item.ts || ''}  ${stripAnsiCodes(item.line || '')}`);

          const { cfLogsDir } = getSandboxPaths(repoDir || sandboxState.currentSourceDir);
          fs.mkdirSync(cfLogsDir, { recursive: true });
          const logFile = path.join(cfLogsDir, `cf-error-${projectName}-${Date.now()}.log`);
          fs.writeFileSync(logFile, formattedLines.join('\n'), 'utf-8');

          sandboxState.buildHistory.lastCloudflareDeployment = {
            id: dep.id,
            projectName,
            status: 'FAILED',
            failedStage: currentStageName,
            elapsed: elapsedFormatted,
            savedLogFile: logFile,
            logs: formattedLines.slice(-120)
          };

          formattedLines.slice(-35).forEach((ln) => sendLog(ln, 'stderr', 'deploy'));
          sendLog(`Cloudflare failure log captured. Click "🔄 Retry Cloudflare Build" or export the .md Report.`, 'info', 'deploy');
        } catch (logErr) {
          sendLog(`Unable to retrieve detailed Cloudflare log history: ${logErr.message}`, 'stderr', 'deploy');
        }

        sendStatus('cf-failed', {
          deploymentId: dep.id,
          projectName,
          accountId,
          stageName: currentStageName,
          elapsed: elapsedFormatted
        });
      }
    } catch (err) {
      sendLog(`[CLOUDFLARE POLL WARNING] ${err.message}`, 'stderr', 'deploy');
    } finally {
      pollInFlight = false;
    }
  }, 1200);
}
