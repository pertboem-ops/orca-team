import { inspectLiveCliRouting, loadTeamRolesConfig } from './probe.mjs';

export class TeamRoutingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TeamRoutingError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolve deterministic role, CLI, model, family, confidence, and cross-family avoidance
 * from `(type, hard, targetTask, probe, workspaceRoot)`.
 */
export function resolveRoleRoute({
  type,
  hard = false,
  targetTask = null,
  probe,
  workspaceRoot = null
}) {
  const cfg = loadTeamRolesConfig();
  const routeEntry = cfg.typeRouting?.[type];
  if (!routeEntry) {
    throw new TeamRoutingError(
      'TEAM_INVALID_TASK_TYPE',
      `Unsupported task type "${String(type)}". Expected one of: ${Object.keys(cfg.typeRouting || {}).join(', ')}.`
    );
  }

  const tierKey = hard ? 'hard' : 'normal';
  const mapped = routeEntry[tierKey] || routeEntry.normal;
  const roleId = mapped.role;
  const roleSpec = cfg.roles?.[roleId];
  if (!roleSpec) {
    throw new TeamRoutingError('TEAM_ROLE_NOT_CONFIGURED', `Role "${roleId}" is missing in team-roles.json.`);
  }

  const candidateChain = roleSpec.tiers?.[mapped.tier] || roleSpec.tiers?.normal || [];
  if (candidateChain.length === 0) {
    throw new TeamRoutingError('TEAM_EMPTY_ROLE_CHAIN', `Role "${roleId}" has no candidate CLIs configured.`);
  }

  const enforceCrossFamily = Boolean(roleSpec.enforceCrossFamily && targetTask);
  const forbiddenFamilies = new Set();

  if (enforceCrossFamily) {
    const rawWriterFamilies = Array.isArray(targetTask.writerFamilies)
      ? targetTask.writerFamilies.filter(Boolean)
      : targetTask.actualProviderFamily
        ? [targetTask.actualProviderFamily]
        : [];

    if (rawWriterFamilies.length === 0 || rawWriterFamilies.includes('unknown')) {
      throw new TeamRoutingError(
        'TEAM_CROSS_FAMILY_UNAVAILABLE',
        `无法对目标任务 "${targetTask.taskId}" 执行异源审查：目标写任务的模型家族记录为空或包含 "unknown"（${JSON.stringify(rawWriterFamilies)}），网关按 fail-closed 契约拒绝同源盲审。`,
        {
          targetTaskId: targetTask.taskId,
          writerFamilies: rawWriterFamilies
        }
      );
    }

    for (const fam of rawWriterFamilies) {
      forbiddenFamilies.add(fam);
    }
  }

  const skippedCandidates = [];
  let selected = null;
  let selectedIndex = -1;

  for (let idx = 0; idx < candidateChain.length; idx += 1) {
    const cand = candidateChain[idx];
    const cliStatus = probe?.clis?.[cand.cli];
    const cliCap = cfg.cliCapabilities?.[cand.cli] || {
      supportsModelFlag: false,
      supportsEffortFlag: false
    };

    if (!cliStatus || !cliStatus.installed || !cliStatus.authenticated) {
      skippedCandidates.push({
        index: idx,
        cli: cand.cli,
        model: cand.model || null,
        reason: !cliStatus?.installed ? 'cli_not_installed' : 'cli_not_authenticated'
      });
      continue;
    }

    // Freshly read live CLI config at dispatch time to determine actualProviderFamily & familyConfidence
    const live = inspectLiveCliRouting(
      cand.cli,
      cliCap.supportsModelFlag ? cand.model : null,
      workspaceRoot
    );

    if (enforceCrossFamily) {
      if (!live.actualProviderFamily || live.actualProviderFamily === 'unknown' || live.familyConfidence === 'unknown') {
        skippedCandidates.push({
          index: idx,
          cli: cand.cli,
          model: live.model,
          actualProviderFamily: live.actualProviderFamily,
          reason: 'unknown_reviewer_family'
        });
        continue;
      }
      if (forbiddenFamilies.has(live.actualProviderFamily)) {
        skippedCandidates.push({
          index: idx,
          cli: cand.cli,
          model: live.model,
          actualProviderFamily: live.actualProviderFamily,
          reason: `same_family_as_writer(${live.actualProviderFamily})`
        });
        continue;
      }
    }

    selected = {
      roleId,
      roleTitle: roleSpec.title,
      mode: roleSpec.mode,
      tier: mapped.tier,
      candidateIndex: idx,
      cli: cand.cli,
      model: cliCap.supportsModelFlag ? cand.model : live.model,
      requestedModelFlag: cliCap.supportsModelFlag ? cand.model : null,
      effort: cliCap.supportsEffortFlag ? cand.effort : null,
      passModelFlag: Boolean(cliCap.supportsModelFlag && cand.model),
      passEffortFlag: Boolean(cliCap.supportsEffortFlag && cand.effort),
      actualProviderFamily: live.actualProviderFamily || 'unknown',
      familyConfidence: live.familyConfidence || 'unknown',
      degradedFrom:
        idx > 0
          ? `${candidateChain[0].cli}:${candidateChain[0].model || '<default>'}`
          : null,
      crossFamilyVerifiedAgainst: enforceCrossFamily ? [...forbiddenFamilies] : [],
      skippedCandidates
    };
    selectedIndex = idx;
    break;
  }

  if (!selected) {
    if (enforceCrossFamily) {
      throw new TeamRoutingError(
        'TEAM_CROSS_FAMILY_UNAVAILABLE',
        `异源审查门禁（Fail-Closed）拦截：目标任务 "${targetTask.taskId}" 已使用写模型家族 [${[...forbiddenFamilies].join(', ')}]，当前没有其他已登录且异源的审查候选可用。跳过明细：${JSON.stringify(skippedCandidates)}`,
        {
          targetTaskId: targetTask.taskId,
          forbiddenFamilies: [...forbiddenFamilies],
          skippedCandidates
        }
      );
    }

    throw new TeamRoutingError(
      'TEAM_NO_READY_CLI_FOR_ROLE',
      `角色 "${roleId}" (${mapped.tier}) 的三级候选 CLI 均不可用或未登录。跳过明细：${JSON.stringify(skippedCandidates)}`,
      {
        roleId,
        tier: mapped.tier,
        skippedCandidates
      }
    );
  }

  return selected;
}

export function buildBoardRoutingSummary(probe, workspaceRoot = null) {
  const cfg = loadTeamRolesConfig();
  const summary = [];
  for (const [roleId, roleSpec] of Object.entries(cfg.roles || {})) {
    const tiersOut = {};
    for (const [tierName, chain] of Object.entries(roleSpec.tiers || {})) {
      tiersOut[tierName] = chain.map((cand, idx) => {
        const cliInfo = probe?.clis?.[cand.cli];
        const cliCap = cfg.cliCapabilities?.[cand.cli] || {};
        const live = inspectLiveCliRouting(
          cand.cli,
          cliCap.supportsModelFlag ? cand.model : null,
          workspaceRoot
        );
        return {
          tierRank: idx === 0 ? 'primary' : `fallback${idx}`,
          cli: cand.cli,
          model: cliCap.supportsModelFlag ? cand.model : live.model,
          effort: cliCap.supportsEffortFlag ? cand.effort : null,
          actualProviderFamily: live.actualProviderFamily,
          familyConfidence: live.familyConfidence,
          ready: Boolean(cliInfo?.installed && cliInfo?.authenticated)
        };
      });
    }
    summary.push({
      roleId,
      title: roleSpec.title,
      mode: roleSpec.mode,
      enforceCrossFamily: Boolean(roleSpec.enforceCrossFamily),
      tiers: tiersOut
    });
  }
  return summary;
}
