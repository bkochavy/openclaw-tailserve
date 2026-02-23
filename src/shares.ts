import { statSync } from "node:fs";
import path from "node:path";

import { lookup as lookupMimeType } from "mime-types";
import { nanoid } from "nanoid";

import { ensureTailserveServerRunning } from "./server-process.js";
import { enableTailscaleFunnelRoute, ensureTailscaleServeForFirstShare } from "./tailscale.js";
import { type ShareRecord, type TailserveState, readState, toShareUrl, updateState, writeState } from "./state.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const SHARE_ID_LENGTH = 8;

export interface CreateShareResult {
  id: string;
  url: string;
  share: ShareRecord;
  warning?: string;
}

export interface CreateFileShareOptions {
  ttlMs?: number;
  persist?: boolean;
  public?: boolean;
}

export interface CreateEditShareOptions {
  readonly?: boolean;
  ttlMs?: number;
  persist?: boolean;
}

export interface CreateProxyShareOptions {
  ensureServerRunning?: boolean;
  setupTailscaleRoute?: boolean;
  public?: boolean;
  state?: TailserveState;
}

export function removeShareById(id: string): boolean {
  const normalizedId = id.trim();
  if (normalizedId.length === 0) {
    throw new Error("Share id is required");
  }

  const state = readState();
  if (!(normalizedId in state.shares)) {
    return false;
  }

  delete state.shares[normalizedId];
  writeState(state);
  return true;
}

export function removeEphemeralShares(): number {
  const state = readState();
  const ephemeralIds = Object.entries(state.shares)
    .filter(([, share]) => share.persist !== true)
    .map(([id]) => id);

  if (ephemeralIds.length === 0) {
    return 0;
  }

  for (const id of ephemeralIds) {
    delete state.shares[id];
  }

  writeState(state);
  return ephemeralIds.length;
}

export function removeExpiredShares(nowMs = Date.now()): number {
  const state = readState();
  const expiredIds = Object.entries(state.shares)
    .filter(([, share]) => {
      if (share.expiresAt === null) {
        return false;
      }

      const expiresAtMs = Date.parse(share.expiresAt);
      if (Number.isNaN(expiresAtMs)) {
        return false;
      }

      return expiresAtMs <= nowMs;
    })
    .map(([id]) => id);

  if (expiredIds.length === 0) {
    return 0;
  }

  for (const id of expiredIds) {
    delete state.shares[id];
  }

  writeState(state);
  return expiredIds.length;
}

export function createFileShare(targetPath: string, options?: CreateFileShareOptions): CreateShareResult {
  if (targetPath.trim().length === 0) {
    throw new Error("Path is required");
  }

  const absolutePath = path.resolve(targetPath);

  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new Error(`File not found: ${targetPath}`);
  }

  let shareType: ShareRecord["type"];
  if (stats.isFile()) {
    shareType = "file";
  } else if (stats.isDirectory()) {
    shareType = "dir";
  } else {
    throw new Error(`Not a file or directory: ${targetPath}`);
  }

  const state = readState();
  const firstShareSetup = options?.public === true ? enableTailscaleFunnelRoute(state) : ensureTailscaleServeForFirstShare(state);
  const id = nanoid(SHARE_ID_LENGTH);
  const createdAt = new Date();
  const persist = options?.persist === true;
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const mimeType = shareType === "file" ? lookupMimeType(absolutePath) : undefined;

  const share: ShareRecord = {
    id,
    type: shareType,
    path: absolutePath,
    createdAt: createdAt.toISOString(),
    expiresAt: persist ? null : new Date(createdAt.getTime() + ttlMs).toISOString(),
    persist,
    readonly: false,
    mimeType: typeof mimeType === "string" ? mimeType : undefined,
    public: options?.public === true ? true : undefined,
  };

  const persistedState = updateState((currentState) => {
    currentState.tsHostname = state.tsHostname;
    currentState.tsPort = state.tsPort;
    currentState.tsProtocol = state.tsProtocol;
    currentState.shares[id] = share;
  });
  let urlState = persistedState;

  // Start the server AFTER writing state so the server's startup cleanup
  // sees the new share and doesn't race to overwrite it.
  try {
    const serverStarted = ensureTailserveServerRunning({ state: persistedState });
    if (serverStarted) {
      urlState = readState();
    }
  } catch (error: unknown) {
    updateState((currentState) => {
      delete currentState.shares[id];
    });
    throw error;
  }

  return {
    id,
    url: toShareUrl(urlState, id),
    share,
    warning: firstShareSetup.warning,
  };
}

export function createEditShare(targetPath: string, options?: CreateEditShareOptions): CreateShareResult {
  if (targetPath.trim().length === 0) {
    throw new Error("Path is required");
  }

  const absolutePath = path.resolve(targetPath);

  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new Error(`File not found: ${targetPath}`);
  }

  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${targetPath}`);
  }

  let state = readState();
  const serverStarted = ensureTailserveServerRunning({ state });
  if (serverStarted) {
    state = readState();
  }
  const firstShareSetup = ensureTailscaleServeForFirstShare(state);

  const id = nanoid(SHARE_ID_LENGTH);
  const createdAt = new Date();
  const persist = options?.persist === true;
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;

  const share: ShareRecord = {
    id,
    type: "edit",
    path: absolutePath,
    createdAt: createdAt.toISOString(),
    expiresAt: persist ? null : new Date(createdAt.getTime() + ttlMs).toISOString(),
    persist,
    readonly: options?.readonly === true,
  };

  updateState((currentState) => {
    currentState.tsHostname = state.tsHostname;
    currentState.tsPort = state.tsPort;
    currentState.tsProtocol = state.tsProtocol;
    currentState.shares[id] = share;
  });

  return {
    id,
    url: toShareUrl(state, id),
    share,
    warning: firstShareSetup.warning,
  };
}

export function createProxyShare(port: number, options?: CreateProxyShareOptions): CreateShareResult {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }

  let state = options?.state ?? readState();
  if (options?.ensureServerRunning !== false) {
    const serverStarted = ensureTailserveServerRunning({ state });
    if (serverStarted) {
      state = readState();
    }
  }

  const firstShareSetup =
    options?.setupTailscaleRoute === false
      ? {}
      : options?.public === true
        ? enableTailscaleFunnelRoute(state)
        : ensureTailscaleServeForFirstShare(state);
  const id = nanoid(SHARE_ID_LENGTH);
  const createdAt = new Date();

  const share: ShareRecord = {
    id,
    type: "proxy",
    port,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + DEFAULT_TTL_MS).toISOString(),
    persist: false,
    readonly: false,
    public: options?.public === true ? true : undefined,
  };

  updateState((currentState) => {
    currentState.tsHostname = state.tsHostname;
    currentState.tsPort = state.tsPort;
    currentState.tsProtocol = state.tsProtocol;
    currentState.shares[id] = share;
  });

  return {
    id,
    url: toShareUrl(state, id),
    share,
    warning: firstShareSetup.warning,
  };
}
