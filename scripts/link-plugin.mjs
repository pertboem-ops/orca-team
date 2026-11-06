#!/usr/bin/env node
/**
 * Cross-platform Antigravity plugin linker for `orca-team`.
 *
 * Performs two idempotent registrations (matching `orca-cabinet`):
 * 1. Registers `{ path: "<parentDir>", include_only: ["orca-team"] }` in
 *    `~/.gemini/config/plugins.json` while preserving all existing plugin entries.
 * 2. Creates a convenience Directory Junction (Windows, zero admin privileges) or
 *    symlink (macOS/Linux) at `~/.gemini/config/plugins/orca-team`.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const PLUGIN_DIR_NAME = basename(REPO_ROOT);
const PARENT_DIR = dirname(REPO_ROOT);
const ANTIGRAVITY_PARENT_PATH =
  process.platform === 'win32'
    ? `/${PARENT_DIR.replace(/\\/g, '/')}`
    : PARENT_DIR;

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || homedir();
const CONFIG_DIR = join(HOME_DIR, '.gemini', 'config');
const PLUGINS_DIR = join(CONFIG_DIR, 'plugins');
const PLUGINS_JSON = join(CONFIG_DIR, 'plugins.json');
const TARGET_LINK = join(PLUGINS_DIR, PLUGIN_DIR_NAME);

const args = new Set(process.argv.slice(2));
const mode = args.has('--unlink') ? 'unlink' : args.has('--status') ? 'status' : 'link';

function isLinkOrJunction(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeExistingLink(p) {
  if (!isLinkOrJunction(p)) {
    if (existsSync(p)) {
      throw new Error(`Refusing to overwrite non-link directory at "${p}".`);
    }
    return false;
  }
  try {
    unlinkSync(p);
  } catch {
    rmSync(p, { recursive: true, force: true });
  }
  return true;
}

function readPluginsJson() {
  if (!existsSync(PLUGINS_JSON)) {
    return { entries: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(PLUGINS_JSON, 'utf8'));
    return {
      ...parsed,
      entries: Array.isArray(parsed.entries) ? parsed.entries : []
    };
  } catch {
    return { entries: [] };
  }
}

function isOurEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const normPath = String(entry.path || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const expectedNorm = PARENT_DIR.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return (
    normPath === expectedNorm &&
    Array.isArray(entry.include_only) &&
    entry.include_only.length === 1 &&
    entry.include_only[0] === PLUGIN_DIR_NAME
  );
}

if (mode === 'status') {
  const linked = isLinkOrJunction(TARGET_LINK);
  const resolved = linked && existsSync(TARGET_LINK) ? realpathSync(TARGET_LINK) : null;
  const cfg = readPluginsJson();
  const registeredInPluginsJson = cfg.entries.some(isOurEntry);
  console.log(
    JSON.stringify(
      {
        repoRoot: REPO_ROOT,
        pluginsJson: PLUGINS_JSON,
        registeredInPluginsJson,
        targetLink: TARGET_LINK,
        linked,
        resolvedTarget: resolved
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (mode === 'unlink') {
  const removedJunction = removeExistingLink(TARGET_LINK);
  let removedFromPluginsJson = false;
  if (existsSync(PLUGINS_JSON)) {
    const cfg = readPluginsJson();
    const filtered = cfg.entries.filter((e) => !isOurEntry(e));
    removedFromPluginsJson = filtered.length !== cfg.entries.length;
    if (filtered.length === 0 && !cfg.inherits) {
      rmSync(PLUGINS_JSON, { force: true });
    } else {
      writeFileSync(PLUGINS_JSON, `${JSON.stringify({ ...cfg, entries: filtered }, null, 2)}\n`, 'utf8');
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: 'unlink',
        removedJunction,
        removedFromPluginsJson,
        targetLink: TARGET_LINK,
        pluginsJson: PLUGINS_JSON
      },
      null,
      2
    )
  );
  process.exit(0);
}

mkdirSync(PLUGINS_DIR, { recursive: true });
removeExistingLink(TARGET_LINK);

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
symlinkSync(REPO_ROOT, TARGET_LINK, linkType);
const resolvedTarget = realpathSync(TARGET_LINK);

const cfg = readPluginsJson();
if (!cfg.entries.some(isOurEntry)) {
  cfg.entries.push({
    path: ANTIGRAVITY_PARENT_PATH,
    include_only: [PLUGIN_DIR_NAME]
  });
  writeFileSync(PLUGINS_JSON, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

console.log(
  JSON.stringify(
    {
      ok: true,
      action: 'link',
      linkType,
      repoRoot: REPO_ROOT,
      pluginsJson: PLUGINS_JSON,
      registeredEntry: { path: ANTIGRAVITY_PARENT_PATH, include_only: [PLUGIN_DIR_NAME] },
      targetLink: TARGET_LINK,
      resolvedTarget
    },
    null,
    2
  )
);
