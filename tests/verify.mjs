#!/usr/bin/env node
/**
 * Static release, syntax, manifest whitelist, routing table, and MCP schema verification gate (`npm run verify`).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeamRolesConfig } from '../server/lib/probe.mjs';
import { TOOLS } from '../server/team-mcp.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const PLUGIN_MANIFEST_ALLOWLIST = new Set([
  'name',
  'description',
  'logo',
  'suggestedPrompts',
  'displayName',
  'version',
  'disabled'
]);

const SCALAR_JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

function assertNoUnionTypes(schemaNode, pathLabel) {
  if (!schemaNode || typeof schemaNode !== 'object') return;
  if ('type' in schemaNode) {
    assert(
      !Array.isArray(schemaNode.type),
      `Union type array forbidden in Antigravity MCP inputSchema at ${pathLabel}: ${JSON.stringify(schemaNode.type)}`
    );
    assert(
      SCALAR_JSON_TYPES.has(schemaNode.type),
      `Invalid JSON Schema type "${schemaNode.type}" at ${pathLabel}`
    );
  }
  if (schemaNode.properties && typeof schemaNode.properties === 'object') {
    for (const [k, v] of Object.entries(schemaNode.properties)) {
      assertNoUnionTypes(v, `${pathLabel}.properties.${k}`);
    }
  }
  if (schemaNode.items) {
    assertNoUnionTypes(schemaNode.items, `${pathLabel}.items`);
  }
}

function parseFrontmatter(md) {
  const m = String(md).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { meta, body: m[2].trim() };
}

function collectMjsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMjsFiles(full));
    } else if (entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

console.log('1. Checking plugin.json strict 7-field allowlist & assets...');
const pluginJson = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
for (const key of Object.keys(pluginJson)) {
  assert(
    PLUGIN_MANIFEST_ALLOWLIST.has(key),
    `Disallowed field "${key}" in plugin.json (breaks Antigravity plugin parser!)`
  );
}
assert.equal(pluginJson.name, 'orca-team');
assert(/^\d+\.\d+\.\d+$/.test(pluginJson.version), 'plugin.json version must be semver');
assert(Array.isArray(pluginJson.suggestedPrompts) && pluginJson.suggestedPrompts.length <= 3);
assert(existsSync(join(ROOT, pluginJson.logo)), `Missing logo file: ${pluginJson.logo}`);

console.log('2. Checking hooks.json, mcp_config.json, rules & skills...');
assert(!existsSync(join(ROOT, '.gemini', 'hooks.json')), 'hooks.json must sit at plugin root');
const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks.json'), 'utf8'));
assert(hooksJson['orca-team-lease-guard']?.PreToolUse?.length === 1);
assert(existsSync(join(ROOT, 'scripts', 'hook-guard.mjs')));

const mcpConfig = JSON.parse(readFileSync(join(ROOT, 'mcp_config.json'), 'utf8'));
assert.equal(mcpConfig.mcpServers?.team?.command, 'node');
assert(existsSync(join(ROOT, 'rules', 'AGENTS.md')));
assert(existsSync(join(ROOT, 'docs', '设计方案-v0.1.md')));
assert(existsSync(join(ROOT, 'docs', '设计方案-v0.2-内阁修订版.md')));

const skillFile = join(ROOT, 'skills', 'team-workflow', 'SKILL.md');
assert(existsSync(skillFile), 'Missing skills/team-workflow/SKILL.md');
const { meta: skillMeta, body: skillBody } = parseFrontmatter(readFileSync(skillFile, 'utf8'));
assert.equal(skillMeta.name, 'team-workflow');
assert(skillMeta.description && skillMeta.description.length > 15);
assert(skillBody.length > 200);

console.log('3. Running `node --check` syntax verification across all .mjs modules...');
const mjsFiles = [
  ...collectMjsFiles(join(ROOT, 'server')),
  ...collectMjsFiles(join(ROOT, 'scripts')),
  ...collectMjsFiles(join(ROOT, 'tests'))
];
assert(mjsFiles.length >= 12, `Expected >= 12 .mjs files, found ${mjsFiles.length}`);
for (const file of mjsFiles) {
  const chk = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(chk.status, 0, `Syntax error in ${file}:\n${chk.stderr}`);
}

console.log('4. Checking config/team-roles.json v0.2 Cabinet invariants...');
const rolesCfg = loadTeamRolesConfig();
assert.equal(rolesCfg.schemaVersion, 2);
assert.equal(rolesCfg.maxBatchSize, 4);
assert(rolesCfg.maxWaitSeconds <= 55, 'maxWaitSeconds must stay <= 55s');
assert.equal(
  rolesCfg.cliCapabilities?.opencode?.supportsModelFlag,
  false,
  'opencode supportsModelFlag must be false per v0.2 live machine verification'
);

const expectedRoles = ['architect', 'coder-fast', 'coder-pro', 'reviewer', 'tester'];
for (const roleId of expectedRoles) {
  const role = rolesCfg.roles?.[roleId];
  assert(role, `Missing role "${roleId}" in team-roles.json`);
  for (const [tierName, chain] of Object.entries(role.tiers || {})) {
    assert(chain.length >= 3, `Role ${roleId}.${tierName} must have >= 3 fallback candidates`);
    const distinctFamilies = new Set(chain.map((c) => c.expectedFamily));
    assert(
      distinctFamilies.size >= 3,
      `Role ${roleId}.${tierName} must span >= 3 distinct model families, got ${[...distinctFamilies].join(', ')}`
    );
    for (const cand of chain) {
      if (!rolesCfg.cliCapabilities?.[cand.cli]?.supportsModelFlag) {
        assert.equal(
          cand.model,
          null,
          `Candidate ${cand.cli} in ${roleId}.${tierName} must have model: null because supportsModelFlag is false`
        );
      }
    }
  }
}
assert.equal(rolesCfg.roles.reviewer.enforceCrossFamily, true);
assert(rolesCfg.roles.reviewer.tiers.normal.some((c) => c.cli === 'antigravity'));
assert(rolesCfg.roles.reviewer.tiers.hard.some((c) => c.cli === 'antigravity'));

console.log('5. Checking 9 MCP TOOLS schema compliance (scalar types & exact tool names)...');
const expectedTools = [
  'team_board',
  'team_delegate',
  'team_delegate_batch',
  'team_approve',
  'team_steer',
  'team_inspect',
  'team_interrupt',
  'team_merge',
  'team_from_protocol'
];
assert.deepEqual(
  TOOLS.map((t) => t.name),
  expectedTools
);
for (const tool of TOOLS) {
  assert.equal(tool.inputSchema?.type, 'object');
  assertNoUnionTypes(tool.inputSchema, tool.name);
}

console.log('\n[VERIFY PASSED] All manifest, syntax, skill, v0.2 routing, and 9-tool MCP schema checks succeeded.');
