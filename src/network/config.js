import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from '../config/index.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolvePath(__dirname, '../..');

export const SOGNI_PROTOCOL_VERSION = '3.0.0129';
export const COMFY_WORKER_VERSION = '1.0.260';
export const MAX_MEDIA_WORKER_CONCURRENT_JOBS = 1;
export const COMFY_FAST_WORKER_TYPE = 'Comfy.FastWorker';
export const COMFY_MAC_WORKER_TYPE = 'Comfy.MacWorker';
export const WORKER_NETWORKS = ['fast', 'relaxed'];
export const BACKEND_MODES = ['local', 'http'];

const readPackageVersion = () => {
  try {
    const raw = readFileSync(join(projectRoot, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Fall back when package.json is unavailable.
  }
  return '1.0.0';
};

export const SOGNI_VOICE_WORKER_VERSION = readPackageVersion();

export function clampMediaWorkerConcurrency() {
  return MAX_MEDIA_WORKER_CONCURRENT_JOBS;
}

export const SOGNI_HOSTS = {
  local: {
    socket: 'wss://socket-local.sogni.ai',
    socketApi: 'https://socket-local.sogni.ai/api',
    api: 'https://api-local.sogni.ai',
  },
  staging: {
    socket: 'wss://socket-staging.sogni.ai',
    socketApi: 'https://socket-staging.sogni.ai/api',
    api: 'https://api-staging.sogni.ai',
  },
  production: {
    socket: 'wss://socket.sogni.ai',
    socketApi: 'https://socket.sogni.ai/api',
    api: 'https://api.sogni.ai',
  },
};

const clean = (value) => {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
};

const stripTrailingSlash = (url) => String(url).replace(/\/+$/, '');

export function resolveSogniHosts({
  sogniEnv = config.networkWorker?.sogniEnv || process.env.SOGNI_ENV || 'staging',
  socketUrl = process.env.SOGNI_SOCKET_URL,
  socketApiUrl = process.env.SOGNI_SOCKET_API_URL,
  apiUrl = process.env.SOGNI_API_URL,
} = {}) {
  const normalizedEnv = String(sogniEnv || 'staging').trim().toLowerCase();
  const defaults = SOGNI_HOSTS[normalizedEnv];
  if (!defaults) {
    throw new Error(
      `Unknown SOGNI_ENV "${sogniEnv}" (expected local, staging, or production)`,
    );
  }

  return {
    env: normalizedEnv,
    socket: stripTrailingSlash(clean(socketUrl) || defaults.socket),
    socketApi: stripTrailingSlash(clean(socketApiUrl) || defaults.socketApi),
    api: stripTrailingSlash(clean(apiUrl) || defaults.api),
  };
}

export function resolveSocketUrl(
  sogniEnv = config.networkWorker?.sogniEnv || process.env.SOGNI_ENV || 'staging',
  socketUrlOverride = process.env.SOGNI_SOCKET_URL,
) {
  return resolveSogniHosts({ sogniEnv, socketUrl: socketUrlOverride }).socket;
}

export function resolveWorkerCredentials(env = process.env) {
  const apiKey = clean(env.SOGNI_API_KEY)
    || clean(env.API_KEY)
    || clean(env.SOGNI_WORKER_API_KEY)
    || null;
  const nftTokenId = clean(env.SOGNI_NFT_TOKEN_ID) ?? clean(env.NFT_TOKEN_ID) ?? '';
  return { apiKey, nftTokenId };
}

export function resolveWorkerNetwork(raw = process.env.SOGNI_WORKER_NETWORK, platform = process.platform) {
  const value = (clean(raw) || '').toLowerCase();
  if (!value) {
    return platform === 'darwin' ? 'relaxed' : 'fast';
  }
  if (WORKER_NETWORKS.includes(value)) return value;
  throw new Error(
    `Unsupported SOGNI_WORKER_NETWORK "${raw}" (expected one of: ${WORKER_NETWORKS.join(', ')})`,
  );
}

export function hardwareRatingForNetwork(network = 'fast') {
  return network === 'relaxed' ? 16 : 70;
}

export function resolveWorkerType(raw = process.env.SOGNI_WORKER_TYPE, platform = process.platform) {
  const explicit = clean(raw);
  if (explicit) return explicit;
  return platform === 'darwin' ? COMFY_MAC_WORKER_TYPE : COMFY_FAST_WORKER_TYPE;
}

export function workerImageIdentity(
  version = clean(process.env.SOGNI_VOICE_WORKER_VERSION) || SOGNI_VOICE_WORKER_VERSION,
  platform = process.platform,
) {
  const prefix = platform === 'darwin' ? 'sogni-voice-mac' : 'sogni-voice';
  return `${prefix}/${version}`;
}

/**
 * Build Sogni media-worker user-agent string.
 * CRITICAL: use `(darwin)` on macOS and `(linux)` on Linux — NEVER `(macOS)`,
 * so `sogni-socket` classifies the worker under the `comfy-worker/` agent track.
 */
export function buildUserAgent({
  platform = process.platform,
  workerVersion = clean(process.env.SOGNI_COMFY_WORKER_VERSION) || COMFY_WORKER_VERSION,
  protocolVersion = SOGNI_PROTOCOL_VERSION,
} = {}) {
  const osToken = platform === 'darwin'
    ? 'darwin'
    : platform === 'linux'
      ? 'linux'
      : String(platform || 'linux').toLowerCase();
  return `Sogni/${protocolVersion} (${osToken}) | IMG:COMFY | comfy-worker/${workerVersion}`;
}

export function isRunningInDocker({
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  try {
    if (existsSyncImpl('/.dockerenv')) return true;
    const cgroup = readFileSyncImpl('/proc/1/cgroup', 'utf-8');
    return cgroup.includes('docker') || cgroup.includes('kubepods') || cgroup.includes('containerd');
  } catch {
    return false;
  }
}

export function isDgxSparkGpu(gpuBrand = '') {
  const normalized = String(gpuBrand || '').trim().toLowerCase();
  return /(?:^|[^a-z0-9])gb10(?:[^a-z0-9]|$)/.test(normalized)
    || normalized.includes('dgx spark');
}

export function resolveEffectiveNvidiaVramGB(gpuBrand, reportedVramGB, systemRamGB) {
  if (reportedVramGB !== null && reportedVramGB !== undefined && Number.isFinite(reportedVramGB)) {
    return reportedVramGB;
  }
  return isDgxSparkGpu(gpuBrand) ? systemRamGB : null;
}

const isUsableHardwareName = (value) => {
  const trimmed = clean(value);
  if (!trimmed) return false;
  return !/^(?:unknown|\[?n\/a\]?|none|null|\d+)$/i.test(trimmed);
};

function readLinuxProcGpuBrand(readdirSyncImpl = readdirSync, readFileSyncImpl = readFileSync) {
  try {
    const dir = '/proc/driver/nvidia/gpus';
    for (const entry of readdirSyncImpl(dir)) {
      const info = readFileSyncImpl(join(dir, entry, 'information'), 'utf-8');
      const match = /^Model:\s*(.+)$/m.exec(info);
      if (isUsableHardwareName(match?.[1])) return match[1].trim();
    }
  } catch {
    // Ignore when /proc/driver/nvidia/gpus is unavailable.
  }
  try {
    const dtModel = readFileSyncImpl('/proc/device-tree/model', 'utf-8').replace(/\0/g, '').trim();
    if (/dgx\s*spark|gb10/i.test(dtModel)) return 'NVIDIA GB10';
  } catch {
    // Ignore on non-ARM / non-DT systems.
  }
  return null;
}

async function readLinuxCpuBrand(
  cpus = os.cpus(),
  readFileSyncImpl = readFileSync,
  arch = process.arch,
  execFileImpl = execFileAsync,
) {
  const fromOs = cpus?.[0]?.model?.trim();
  if (isUsableHardwareName(fromOs)) return fromOs;
  try {
    const cpuinfo = readFileSyncImpl('/proc/cpuinfo', 'utf-8');
    // Case-sensitive: ARM64 /proc/cpuinfo starts every core stanza with lowercase `processor : 0`.
    const match = /^(?:model name|Model|Hardware|Processor)\s*:\s*(.+)$/m.exec(cpuinfo);
    if (isUsableHardwareName(match?.[1])) return match[1].trim();
  } catch {
    // Ignore if /proc/cpuinfo is unreadable.
  }
  try {
    const { stdout } = await execFileImpl('lscpu', [], { timeout: 3000 });
    const match = /^Model name:\s*(.+)$/m.exec(String(stdout || ''));
    if (isUsableHardwareName(match?.[1])) return match[1].trim();
  } catch {
    // Ignore when lscpu is unavailable.
  }
  return `${arch || 'arm64'} CPU`;
}

export async function probeHardwareInfo({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  totalMemBytes = os.totalmem(),
  cpus = os.cpus(),
  hostname = os.hostname(),
  execFileImpl = execFileAsync,
  readdirSyncImpl = readdirSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  const ramOverride = Number(clean(env.SOGNI_RAM_GB));
  const ram = Number.isFinite(ramOverride) && ramOverride > 0
    ? Math.round(ramOverride)
    : Math.max(1, Math.round(totalMemBytes / (1024 ** 3)));
  const vramOverride = Number(clean(env.SOGNI_VRAM_GB));
  const explicitGpuBrand = clean(env.SOGNI_GPU_BRAND);
  const explicitCpuBrand = clean(env.SOGNI_CPU_BRAND);

  const logicalCores = Array.isArray(cpus) && cpus.length > 0 ? cpus.length : 1;
  const cpuFrequency = Number(cpus?.[0]?.speed) || 0;

  if (platform === 'darwin') {
    let chipName = explicitGpuBrand || explicitCpuBrand || cpus?.[0]?.model?.trim() || 'Apple Silicon';
    if (!explicitGpuBrand && !explicitCpuBrand) {
      try {
        const { stdout } = await execFileImpl('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], {
          timeout: 3000,
        });
        if (stdout?.trim()) chipName = stdout.trim();
      } catch {
        // Fall back to os.cpus() model on sandboxed test runs.
      }
    }
    const vram = Number.isFinite(vramOverride) && vramOverride > 0 ? Math.round(vramOverride) : ram;
    return {
      hasANE: true,
      cpuBrand: explicitCpuBrand || chipName,
      gpuBrand: explicitGpuBrand || chipName,
      vram,
      ram,
      numberOfPhysicalCores: logicalCores,
      numberOfLogicalCores: logicalCores,
      cpuFrequency,
      hostname,
      useragent: 'darwin',
      nvidiaDriverVersion: null,
      nvidiaCudaVersion: null,
      nvidiaComputeCapability: null,
      supportedControlnets: {},
    };
  }

  let gpuBrand = explicitGpuBrand || null;
  let reportedVramGB = null;
  let nvidiaDriverVersion = null;

  try {
    const { stdout } = await execFileImpl(
      'nvidia-smi',
      ['--query-gpu=gpu_name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    );
    const firstLine = String(stdout || '').trim().split('\n')[0] || '';
    const parts = firstLine.split(',').map((part) => part.trim());
    if (parts.length >= 2) {
      if (!gpuBrand && isUsableHardwareName(parts[0])) gpuBrand = parts[0];
      const vramMB = Number.parseInt(parts[1], 10);
      if (Number.isFinite(vramMB) && vramMB > 0) {
        reportedVramGB = Math.round(vramMB / 1024);
      }
      if (isUsableHardwareName(parts[2])) nvidiaDriverVersion = parts[2];
    }
  } catch {
    // Sidecar containers without GPU passthrough may not carry nvidia-smi.
  }

  if (!gpuBrand) {
    gpuBrand = readLinuxProcGpuBrand(readdirSyncImpl, readFileSyncImpl);
  }
  if (!gpuBrand && platform === 'linux' && arch === 'arm64' && ram >= 64) {
    gpuBrand = 'NVIDIA GB10';
  }
  if (!gpuBrand) {
    gpuBrand = 'NVIDIA GPU';
  }

  const vram = Number.isFinite(vramOverride) && vramOverride > 0
    ? Math.round(vramOverride)
    : resolveEffectiveNvidiaVramGB(gpuBrand, reportedVramGB, ram);

  const cpuBrand = explicitCpuBrand || await readLinuxCpuBrand(cpus, readFileSyncImpl, arch, execFileImpl);

  return {
    hasANE: false,
    cpuBrand,
    gpuBrand,
    vram,
    ram,
    numberOfPhysicalCores: logicalCores,
    numberOfLogicalCores: logicalCores,
    cpuFrequency,
    hostname,
    useragent: platform === 'linux' ? 'linux' : String(platform),
    nvidiaDriverVersion,
    nvidiaCudaVersion: null,
    nvidiaComputeCapability: null,
    supportedControlnets: {},
  };
}

export function resolveBackendMode(
  rawMode = process.env.SOGNI_VOICE_BACKEND_MODE,
  {
    defaultMode = 'local',
    apiUrl = process.env.SOGNI_VOICE_API_URL,
  } = {},
) {
  const mode = clean(rawMode)?.toLowerCase();
  if (mode) {
    if (!BACKEND_MODES.includes(mode)) {
      throw new Error(
        `Unsupported SOGNI_VOICE_BACKEND_MODE "${rawMode}" (expected one of: ${BACKEND_MODES.join(', ')})`,
      );
    }
    return mode;
  }
  if (clean(apiUrl)) return 'http';
  return defaultMode;
}

export function parseModelAllowlist(raw = process.env.SOGNI_WORKER_MODELS) {
  const cleaned = clean(raw);
  if (!cleaned) return null;
  const ids = cleaned
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

export function loadOrCreateWorkerId(
  workerIdFile = config.networkWorker?.workerIdFile || '.sogni-worker-id',
  explicitWorkerId = process.env.SOGNI_WORKER_ID,
) {
  const explicit = clean(explicitWorkerId);
  if (explicit) return explicit;

  const filePath = isAbsolute(workerIdFile)
    ? workerIdFile
    : resolvePath(projectRoot, workerIdFile);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8').trim();
    if (existing) return existing;
  }

  const id = randomUUID().toUpperCase();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, id);
  return id;
}
