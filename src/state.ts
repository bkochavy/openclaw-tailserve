import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type ShareType = "file" | "dir" | "edit" | "proxy";

export interface ShareRecord {
  id: string;
  type: ShareType;
  path?: string;
  port?: number;
  createdAt: string;
  expiresAt: string | null;
  persist: boolean;
  readonly: boolean;
  mimeType?: string;
  public?: boolean;
  status?: "online" | "offline";
  lastSeen?: string;
}

export interface ProjectRecord {
  public?: boolean;
  [key: string]: unknown;
}

export interface TunnelRecord {
  pid: number;
  url: string;
  port: number;
  createdAt: string;
}

export interface NamedTunnelConfig {
  name: string;
  uuid: string;
  hostname: string;
  credentialsPath: string;
}

export interface TailserveState {
  port: number;
  tsHostname: string;
  tsPort: number;
  tsProtocol?: "https" | "http";
  protectedPorts: number[];
  shares: Record<string, ShareRecord>;
  projects: Record<string, ProjectRecord>;
  tunnels: Record<string, TunnelRecord>;
  namedTunnel?: NamedTunnelConfig;
  namedTunnelPid?: number;
}

export type StateMutator = (state: TailserveState) => void;

const DEFAULT_PORT = 7899;
const DEFAULT_HOSTNAME = "localhost";
const DEFAULT_PROTECTED_PORTS: number[] = [18789];
const PORT_ENV_KEY = "TAILSERVE_PORT";
const PROTECTED_PORTS_ENV_KEY = "TAILSERVE_PROTECTED_PORTS";
const STATE_RELATIVE_PATH = path.join(".tailserve", "state.json");
const SERVER_PID_RELATIVE_PATH = path.join(".tailserve", "server.pid");
const STATE_LOCK_RETRY_COUNT = 5;
const STATE_LOCK_RETRY_DELAY_MS = 100;
const STATE_LOCK_STALE_TIMEOUT_MS = 10_000;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function toObjectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function isShareType(value: unknown): value is ShareType {
  return value === "file" || value === "dir" || value === "edit" || value === "proxy";
}

function parseConfiguredPort(value: string | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    return undefined;
  }

  return parsed;
}

function parsePortNumber(value: number | string): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
      return undefined;
    }

    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    return undefined;
  }

  return parsed;
}

function parsePersistedPort(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  return parsePortNumber(value);
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function normalizePortList(values: ReadonlyArray<string | number>): number[] | undefined {
  const ports: number[] = [];
  for (const value of values) {
    const port = parsePortNumber(value);
    if (port === undefined) {
      continue;
    }

    if (!ports.includes(port)) {
      ports.push(port);
    }
  }

  return ports.length > 0 ? ports : undefined;
}

function parseConfiguredProtectedPorts(value: string | undefined): number[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalizePortList(normalized.split(",").map((entry) => entry.trim()));
}

function parsePersistedProtectedPorts(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return normalizePortList(value.filter((entry): entry is string | number => typeof entry === "string" || typeof entry === "number"));
}

function parsePersistedShareRecord(shareId: string, value: unknown): ShareRecord | undefined {
  const rawShare = toObjectRecord(value);
  if (!isShareType(rawShare.type)) {
    return undefined;
  }

  if (typeof rawShare.createdAt !== "string" || rawShare.createdAt.length === 0) {
    return undefined;
  }

  if (typeof rawShare.persist !== "boolean" || typeof rawShare.readonly !== "boolean") {
    return undefined;
  }

  if (rawShare.expiresAt !== null && (typeof rawShare.expiresAt !== "string" || rawShare.expiresAt.length === 0)) {
    return undefined;
  }

  const share: ShareRecord = {
    id: shareId,
    type: rawShare.type,
    createdAt: rawShare.createdAt,
    expiresAt: rawShare.expiresAt,
    persist: rawShare.persist,
    readonly: rawShare.readonly,
  };

  if (typeof rawShare.mimeType === "string" && rawShare.mimeType.length > 0) {
    share.mimeType = rawShare.mimeType;
  }

  if (rawShare.public === true) {
    share.public = true;
  }

  if (rawShare.status === "online" || rawShare.status === "offline") {
    share.status = rawShare.status;
  }

  if (typeof rawShare.lastSeen === "string" && rawShare.lastSeen.length > 0) {
    share.lastSeen = rawShare.lastSeen;
  }

  if (rawShare.type === "proxy") {
    const sharePort = parsePersistedPort(rawShare.port);
    if (sharePort === undefined) {
      return undefined;
    }

    share.port = sharePort;
    return share;
  }

  if (typeof rawShare.path !== "string" || rawShare.path.length === 0) {
    return undefined;
  }

  if (!path.isAbsolute(rawShare.path)) {
    return undefined;
  }

  share.path = rawShare.path;
  return share;
}

function parsePersistedShares(value: unknown): Record<string, ShareRecord> {
  const shares: Record<string, ShareRecord> = {};
  for (const [shareId, rawShare] of Object.entries(toObjectRecord(value))) {
    const parsedShare = parsePersistedShareRecord(shareId, rawShare);
    if (!parsedShare) {
      continue;
    }

    shares[shareId] = parsedShare;
  }

  return shares;
}

function parsePersistedTunnelRecord(value: unknown): TunnelRecord | undefined {
  const rawTunnel = toObjectRecord(value);
  const pid = parsePositiveInteger(rawTunnel.pid);
  const port = parsePersistedPort(rawTunnel.port);
  if (pid === undefined || port === undefined) {
    return undefined;
  }

  if (typeof rawTunnel.url !== "string" || rawTunnel.url.length === 0) {
    return undefined;
  }

  if (typeof rawTunnel.createdAt !== "string" || rawTunnel.createdAt.length === 0) {
    return undefined;
  }

  return {
    pid,
    url: rawTunnel.url,
    port,
    createdAt: rawTunnel.createdAt,
  };
}

function parsePersistedNamedTunnelConfig(value: unknown): NamedTunnelConfig | undefined {
  const rawConfig = toObjectRecord(value);
  if (typeof rawConfig.name !== "string" || rawConfig.name.length === 0) {
    return undefined;
  }

  if (typeof rawConfig.uuid !== "string" || rawConfig.uuid.length === 0) {
    return undefined;
  }

  if (typeof rawConfig.hostname !== "string" || rawConfig.hostname.length === 0) {
    return undefined;
  }

  if (typeof rawConfig.credentialsPath !== "string" || rawConfig.credentialsPath.length === 0) {
    return undefined;
  }

  return {
    name: rawConfig.name,
    uuid: rawConfig.uuid,
    hostname: rawConfig.hostname,
    credentialsPath: rawConfig.credentialsPath,
  };
}

function parsePersistedTunnels(value: unknown): Record<string, TunnelRecord> {
  const tunnels: Record<string, TunnelRecord> = {};
  for (const [tunnelId, rawTunnel] of Object.entries(toObjectRecord(value))) {
    const parsedTunnel = parsePersistedTunnelRecord(rawTunnel);
    if (!parsedTunnel) {
      continue;
    }

    tunnels[tunnelId] = parsedTunnel;
  }

  return tunnels;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(SLEEP_ARRAY, 0, 0, milliseconds);
}

function isLockStale(lockPath: string): boolean {
  try {
    const lockStats = statSync(lockPath);
    return Date.now() - lockStats.mtimeMs > STATE_LOCK_STALE_TIMEOUT_MS;
  } catch {
    return false;
  }
}

function removeLockIfStale(lockPath: string): boolean {
  if (!isLockStale(lockPath)) {
    return false;
  }

  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireStateLock(lockPath: string): void {
  for (let attempt = 0; attempt <= STATE_LOCK_RETRY_COUNT; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { encoding: "utf8", flag: "wx" });
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    if (removeLockIfStale(lockPath)) {
      continue;
    }

    if (attempt === STATE_LOCK_RETRY_COUNT) {
      throw new Error(`Failed to acquire state lock: ${lockPath}`);
    }

    sleepSync(STATE_LOCK_RETRY_DELAY_MS);
  }
}

function releaseStateLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

export function getStatePath(): string {
  return path.join(homedir(), STATE_RELATIVE_PATH);
}

export function getServerPidPath(): string {
  return path.join(homedir(), SERVER_PID_RELATIVE_PATH);
}

export function createDefaultState(env: NodeJS.ProcessEnv = process.env): TailserveState {
  const configuredPort = parseConfiguredPort(env[PORT_ENV_KEY]) ?? DEFAULT_PORT;
  const configuredProtectedPorts = parseConfiguredProtectedPorts(env[PROTECTED_PORTS_ENV_KEY]) ?? DEFAULT_PROTECTED_PORTS;

  return {
    port: configuredPort,
    tsHostname: DEFAULT_HOSTNAME,
    tsPort: configuredPort,
    tsProtocol: "https",
    protectedPorts: [...configuredProtectedPorts],
    shares: {},
    projects: {},
    tunnels: {},
  };
}

function parsePersistedState(parsed: Record<string, unknown>, env: NodeJS.ProcessEnv): TailserveState {
  const configuredPort = parseConfiguredPort(env[PORT_ENV_KEY]);
  const configuredProtectedPorts = parseConfiguredProtectedPorts(env[PROTECTED_PORTS_ENV_KEY]);
  const statePort = parsePersistedPort(parsed.port) ?? DEFAULT_PORT;
  const port = configuredPort ?? statePort;
  const protectedPorts = configuredProtectedPorts ?? parsePersistedProtectedPorts(parsed.protectedPorts) ?? [...DEFAULT_PROTECTED_PORTS];
  const tsPort = configuredPort ?? parsePersistedPort(parsed.tsPort) ?? statePort;
  const tsHostname = typeof parsed.tsHostname === "string" && parsed.tsHostname.length > 0 ? parsed.tsHostname : DEFAULT_HOSTNAME;

  return {
    port,
    tsHostname,
    tsPort,
    tsProtocol: parsed.tsProtocol === "http" ? "http" : "https",
    protectedPorts,
    shares: parsePersistedShares(parsed.shares),
    projects: toObjectRecord(parsed.projects) as Record<string, ProjectRecord>,
    tunnels: parsePersistedTunnels(parsed.tunnels),
    namedTunnel: parsePersistedNamedTunnelConfig(parsed.namedTunnel),
  };
}

function readStateFile(statePath: string, env: NodeJS.ProcessEnv): TailserveState {
  if (!existsSync(statePath)) {
    return createDefaultState(env);
  }

  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = toObjectRecord(JSON.parse(raw));
    return parsePersistedState(parsed, env);
  } catch {
    return createDefaultState(env);
  }
}

function writeStateFile(statePath: string, state: TailserveState): void {
  const { namedTunnelPid: _namedTunnelPid, ...persistedState } = state;
  const temporaryPath = `${statePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(persistedState, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, statePath);
}

export function readState(env: NodeJS.ProcessEnv = process.env): TailserveState {
  const statePath = getStatePath();
  return readStateFile(statePath, env);
}

export function writeState(state: TailserveState): void {
  const statePath = getStatePath();
  const lockPath = `${statePath}.lock`;
  mkdirSync(path.dirname(statePath), { recursive: true });

  acquireStateLock(lockPath);
  try {
    writeStateFile(statePath, state);
  } finally {
    releaseStateLock(lockPath);
  }
}

export function updateState(mutator: StateMutator, env: NodeJS.ProcessEnv = process.env): TailserveState {
  const statePath = getStatePath();
  const lockPath = `${statePath}.lock`;
  mkdirSync(path.dirname(statePath), { recursive: true });

  acquireStateLock(lockPath);
  try {
    const currentState = readStateFile(statePath, env);
    mutator(currentState);
    writeStateFile(statePath, currentState);
    return currentState;
  } finally {
    releaseStateLock(lockPath);
  }
}

export function toShareOrigin(state: TailserveState): string {
  if (state.tsProtocol === "http") {
    return `http://localhost:${state.port}`;
  }

  return `https://${state.tsHostname}:${state.tsPort}`;
}

export function toShareUrl(state: TailserveState, id: string): string {
  return `${toShareOrigin(state)}/s/${id}`;
}
