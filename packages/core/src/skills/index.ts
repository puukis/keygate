export { SkillsManager } from './manager.js';
export { parseSkillAtPath, parseSkillMarkdown } from './parser.js';
export { discoverSkills, resolveBundledSkillRoots } from './discovery.js';
export { evaluateSkillEligibility, buildEligibilityContext, getSkillEntryKey } from './eligibility.js';
export { parseSlashSkillInvocation, selectActiveSkills } from './matcher.js';
export { formatSkillsForPrompt, buildActiveSkillsPrompt, computeSkillContextHash } from './prompt.js';
export { discoverPluginSkillDirs } from './pluginManifest.js';
export type {
  SkillParseResult,
  SkillDiscoverySnapshot,
  SkillTurnContext,
  SkillManagerStatus,
  SkillDoctorReport,
  SkillInstallRecord,
  SkillInstallState,
  SkillValidationReport,
  SlashSkillResolution,
  SkillInvocation,
} from './types.js';
