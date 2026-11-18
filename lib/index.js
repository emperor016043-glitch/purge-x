export * as payload from "./core/payload.js";
export * as patch from "./core/patch.js";
export * as backup from "./core/backup.js";
export * as util from "./core/util.js";
export * as cdp from "./channels/cdp.js";
export * as ws from "./channels/ws.js";
export * as targets from "./targets/index.js";
export { registry, targetIds, resolveTarget, detectAll, statusAll, applyAll, revertAll } from "./targets/index.js";
export { PROFILES, renderHeader, renderAnchor, renderPersonaSection, renderSkillMarkdown, renderChatSystemPrefix } from "./core/payload.js";
export { STATUS, applyPatches, summarizeReport, injectIntoText, hasBlock } from "./core/patch.js";
export { BackupSession, restoreBackup, latestBackup, listBackups, PURGE_HOME } from "./core/backup.js";

export const VERSION = "2.0.0";
