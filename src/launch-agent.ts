import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCH_AGENT_LABEL = "dev.tailserve";
const LAUNCH_AGENT_RELATIVE_PATH = path.join("Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);

function escapePlistString(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function resolveServerEntryPath(moduleDir: string): string {
  const candidates = [
    path.resolve(moduleDir, "server-entry.js"),
    path.resolve(moduleDir, "..", "dist", "server-entry.js"),
    path.resolve(moduleDir, "server-entry.ts"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function buildLaunchAgentPlist(nodeBinaryPath: string, serverEntryPath: string): string {
  const escapedNodeBinaryPath = escapePlistString(nodeBinaryPath);
  const escapedServerEntryPath = escapePlistString(serverEntryPath);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escapedNodeBinaryPath}</string>`,
    `    <string>${escapedServerEntryPath}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
  ].join("\n");
}

export function getLaunchAgentPlistPath(homePath = homedir()): string {
  return path.join(homePath, LAUNCH_AGENT_RELATIVE_PATH);
}

export function installTailserveLaunchAgent(options?: {
  moduleDir?: string;
  homePath?: string;
  nodeBinaryPath?: string;
}): string {
  const moduleDir = options?.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const homePath = options?.homePath ?? homedir();
  const nodeBinaryPath = options?.nodeBinaryPath ?? process.execPath;
  const serverEntryPath = resolveServerEntryPath(moduleDir);
  const plistPath = getLaunchAgentPlistPath(homePath);

  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, `${buildLaunchAgentPlist(nodeBinaryPath, serverEntryPath)}\n`, "utf8");
  loadLaunchAgentPlist(plistPath);

  return plistPath;
}

function loadLaunchAgentPlist(plistPath: string): void {
  const load = spawnSync("launchctl", ["load", plistPath], { stdio: "ignore" });
  const errorCode = (load.error as NodeJS.ErrnoException | undefined)?.code;

  if (errorCode === "ENOENT") {
    return;
  }

  if (load.error) {
    throw load.error;
  }
}

function unloadLaunchAgentPlist(plistPath: string): void {
  const unload = spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  const errorCode = (unload.error as NodeJS.ErrnoException | undefined)?.code;

  if (errorCode === "ENOENT") {
    return;
  }

  if (unload.error) {
    throw unload.error;
  }
}

export function uninstallTailserveLaunchAgent(options?: { homePath?: string }): string {
  const homePath = options?.homePath ?? homedir();
  const plistPath = getLaunchAgentPlistPath(homePath);

  if (existsSync(plistPath)) {
    unloadLaunchAgentPlist(plistPath);
  }

  rmSync(plistPath, { force: true });
  return plistPath;
}
