import type {
  KeygateConfig,
  SkillDefinition,
  SkillEligibilityReason,
  SkillEntryConfig,
  SkillRuntimeEntry,
  SkillRuntimeSnapshot,
  SkillSourceType,
} from '../types.js';

export interface SkillParseSuccess {
  ok: true;
  value: SkillDefinition;
}

export interface SkillParseFailure {
  ok: false;
  error: string;
}

export type SkillParseResult = SkillParseSuccess | SkillParseFailure;

export interface DiscoveredSkill {
  skill: SkillDefinition;
  precedence: number;
}

export interface SkillConflict {
  name: string;
  kept: SkillDefinition;
  dropped: SkillDefinition;
}

export interface DiscoveryDiagnostic {
  location: string;
  error: string;
}

export interface SkillDiscoverySnapshot {
  loaded: SkillDefinition[];
  conflicts: SkillConflict[];
  diagnostics: DiscoveryDiagnostic[];
  sourceRoots: SkillSourceRoots;
  snapshotVersion: string;
}

export interface SkillSourceRoots {
  workspaceRoot: string;
  globalRoot: string;
  bundledRoots: string[];
  extraRoots: string[];
  pluginRoots: string[];
  pluginSkillRoots: string[];
}

export interface SkillPluginManifest {
  name: string;
  enabled: boolean;
  skillsDirs: string[];
  requiresConfig: string[];
}

export interface SkillEligibilityResult {
  eligible: boolean;
  reason: SkillEligibilityReason;
  envOverlay: Record<string, string>;
  entryConfig: SkillEntryConfig | undefined;
}

export interface SkillSessionCacheEntry {
  snapshotVersion: string;
  entries: SkillRuntimeEntry[];
}

export interface SkillInvocation {
  name: string;
  commandName: string;
  rawArgs: string;
}

export interface SkillDispatchResolution {
  kind: 'dispatch';
  invocation: SkillInvocation;
  skill: SkillDefinition;
  toolName: string;
  args: Record<string, string>;
  envOverlay: Record<string, string>;
}

export interface SkillPromptResolution {
  kind: 'prompt';
  invocation: SkillInvocation;
  skill: SkillDefinition;
  envOverlay: Record<string, string>;
}

export interface SkillNoMatchResolution {
  kind: 'none';
}

export type SlashSkillResolution = SkillDispatchResolution | SkillPromptResolution | SkillNoMatchResolution;

export interface SkillTurnContext {
  snapshotVersion: string;
  contextHash: string;
  loadedCount: number;
  eligibleCount: number;
  eligibleForPrompt: SkillDefinition[];
  activeSkills: SkillDefinition[];
  skillListXml: string;
  activeSkillsPrompt: string;
  envOverlay: Record<string, string>;
}

export interface SkillManagerStatus {
  loadedCount: number;
  eligibleCount: number;
  snapshotVersion: string;
}

export interface SkillManagerOptions {
  config: KeygateConfig;
}

export interface SkillDoctorRecord {
  skill: SkillDefinition;
  eligible: boolean;
  reason: SkillEligibilityReason;
  envOverlay: Record<string, string>;
  entryKey: string;
}

export interface SkillDoctorReport {
  records: SkillDoctorRecord[];
  conflicts: SkillConflict[];
  diagnostics: DiscoveryDiagnostic[];
  snapshotVersion: string;
}

export interface SkillInstallRecord {
  name: string;
  source: string;
  scope: 'workspace' | 'global';
  installedAt: string;
}

export interface SkillInstallState {
  records: Record<string, SkillInstallRecord>;
}

export interface SkillValidationIssue {
  path: string;
  error: string;
}

export interface SkillValidationReport {
  valid: SkillDefinition[];
  issues: SkillValidationIssue[];
}

export interface SkillEligibilityContext {
  config: KeygateConfig;
  allConfig: Record<string, unknown>;
}

export interface SkillEligibilitySnapshot {
  entries: SkillRuntimeEntry[];
  eligible: SkillDefinition[];
}

export interface SkillSessionSnapshot extends SkillRuntimeSnapshot {
  entries: SkillRuntimeEntry[];
}

export interface SkillSelectionOptions {
  explicitInvocation?: SkillInvocation;
  maxActive: number;
}

export interface SkillSelectionResult {
  active: SkillDefinition[];
  activeEnv: Record<string, string>;
}
