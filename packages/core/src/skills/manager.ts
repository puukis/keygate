import path from 'node:path';
import os from 'node:os';
import { watch, type FSWatcher, promises as fs } from 'node:fs';
import type { KeygateConfig, SkillDefinition, SkillRuntimeEntry, SkillRuntimeSnapshot } from '../types.js';
import { discoverSkills } from './discovery.js';
import { buildEligibilityContext, evaluateSkillEligibility, getSkillEntryKey } from './eligibility.js';
import { parseSlashSkillInvocation, selectActiveSkills } from './matcher.js';
import { buildActiveSkillsPrompt, computeSkillContextHash, formatSkillsForPrompt } from './prompt.js';
import { parseSkillAtPath } from './parser.js';
import type {
  SlashSkillResolution,
  SkillDoctorRecord,
  SkillDoctorReport,
  SkillInstallState,
  SkillManagerOptions,
  SkillManagerStatus,
  SkillSessionCacheEntry,
  SkillSourceRoots,
  SkillTurnContext,
  SkillValidationReport,
} from './types.js';

const INSTALL_STATE_FILENAME = '.keygate-installed.json';

export class SkillsManager {
  private readonly config: KeygateConfig;
  private discoveryLoaded = false;
  private refreshing: Promise<void> | null = null;

  private loadedSkills: SkillDefinition[] = [];
  private sourceRoots: SkillSourceRoots | null = null;
  private conflicts: Array<{ name: string; kept: SkillDefinition; dropped: SkillDefinition }> = [];
  private diagnostics: Array<{ location: string; error: string }> = [];
  private snapshotVersion = 'empty';

  private readonly sessionCache = new Map<string, SkillSessionCacheEntry>();
  private watchers: FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(options: SkillManagerOptions) {
    this.config = options.config;
  }

  async ensureReady(): Promise<void> {
    if (this.discoveryLoaded) {
      return;
    }

    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return this.refreshing;
    }

    this.refreshing = this.refreshInternal();

    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async refreshInternal(): Promise<void> {
    const snapshot = await discoverSkills(this.config);

    this.loadedSkills = snapshot.loaded;
    this.sourceRoots = snapshot.sourceRoots;
    this.conflicts = snapshot.conflicts;
    this.diagnostics = snapshot.diagnostics;
    this.snapshotVersion = snapshot.snapshotVersion;
    this.sessionCache.clear();
    this.discoveryLoaded = true;

    if (this.config.skills?.load.watch !== false) {
      await this.setupWatchers();
    }
  }

  getStatusSync(sessionId = 'default'): SkillManagerStatus {
    const snapshot = this.sessionCache.get(sessionId);
    const eligibleCount = snapshot
      ? snapshot.entries.filter((entry) => entry.eligible).length
      : this.evaluateEntries().filter((entry) => entry.eligible).length;

    return {
      loadedCount: this.loadedSkills.length,
      eligibleCount,
      snapshotVersion: this.snapshotVersion,
    };
  }

  async getSessionSnapshot(sessionId: string): Promise<SkillRuntimeSnapshot> {
    await this.ensureReady();

    const cached = this.sessionCache.get(sessionId);
    if (cached && cached.snapshotVersion === this.snapshotVersion) {
      return {
        snapshotVersion: this.snapshotVersion,
        loaded: [...this.loadedSkills],
        entries: [...cached.entries],
        eligible: cached.entries.filter((entry) => entry.eligible).map((entry) => entry.skill),
      };
    }

    const entries = this.evaluateEntries();
    this.sessionCache.set(sessionId, {
      snapshotVersion: this.snapshotVersion,
      entries,
    });

    return {
      snapshotVersion: this.snapshotVersion,
      loaded: [...this.loadedSkills],
      entries: [...entries],
      eligible: entries.filter((entry) => entry.eligible).map((entry) => entry.skill),
    };
  }

  async resolveSlashCommand(sessionId: string, content: string): Promise<SlashSkillResolution> {
    const parsed = parseSlashSkillInvocation(content);
    if (!parsed) {
      return { kind: 'none' };
    }

    const sessionSnapshot = await this.getSessionSnapshot(sessionId);
    const matched = sessionSnapshot.entries.find((entry) => entry.skill.name === parsed.name && entry.eligible);

    if (!matched || !matched.skill.userInvocable) {
      return { kind: 'none' };
    }

    if (matched.skill.commandDispatch === 'tool' && matched.skill.commandTool) {
      return {
        kind: 'dispatch',
        invocation: parsed,
        skill: matched.skill,
        toolName: matched.skill.commandTool,
        args: {
          command: parsed.rawArgs,
          commandName: parsed.commandName,
          skillName: matched.skill.name,
        },
        envOverlay: matched.envOverlay,
      };
    }

    return {
      kind: 'prompt',
      invocation: parsed,
      skill: matched.skill,
      envOverlay: matched.envOverlay,
    };
  }

  async buildTurnContext(
    sessionId: string,
    message: string,
    explicitInvocation?: { name: string; commandName: string; rawArgs: string }
  ): Promise<SkillTurnContext> {
    const snapshot = await this.getSessionSnapshot(sessionId);

    const eligibleForPrompt = snapshot.eligible.filter((skill) => !skill.disableModelInvocation);
    const selection = selectActiveSkills(snapshot.eligible, message, {
      explicitInvocation,
      maxActive: 3,
    });

    const entryByName = new Map<string, SkillRuntimeEntry>(
      snapshot.entries.map((entry) => [entry.skill.name, entry])
    );

    const envOverlay: Record<string, string> = {};
    for (const skill of selection.active) {
      const entry = entryByName.get(skill.name);
      if (!entry) {
        continue;
      }

      for (const [key, value] of Object.entries(entry.envOverlay)) {
        if (!(key in envOverlay)) {
          envOverlay[key] = value;
        }
      }
    }

    const skillListXml = formatSkillsForPrompt(eligibleForPrompt);
    const activeSkillsPrompt = buildActiveSkillsPrompt(selection.active, {
      maxActive: 3,
      maxBodyCharsPerSkill: 6000,
      maxBodyCharsTotal: 15000,
    }).prompt;

    const contextHash = computeSkillContextHash({
      snapshotVersion: snapshot.snapshotVersion,
      skillListXml,
      activeSkillsPrompt,
      explicitSkillName: explicitInvocation?.name,
    });

    return {
      snapshotVersion: snapshot.snapshotVersion,
      contextHash,
      loadedCount: snapshot.loaded.length,
      eligibleCount: snapshot.eligible.length,
      eligibleForPrompt,
      activeSkills: selection.active,
      skillListXml,
      activeSkillsPrompt,
      envOverlay,
    };
  }

  async getDoctorReport(sessionId = 'doctor'): Promise<SkillDoctorReport> {
    const snapshot = await this.getSessionSnapshot(sessionId);

    const records: SkillDoctorRecord[] = snapshot.entries.map((entry) => ({
      skill: entry.skill,
      eligible: entry.eligible,
      reason: entry.reason,
      envOverlay: { ...entry.envOverlay },
      entryKey: getSkillEntryKey(entry.skill),
    }));

    return {
      records,
      conflicts: [...this.conflicts],
      diagnostics: [...this.diagnostics],
      snapshotVersion: this.snapshotVersion,
    };
  }

  async listSkills(sessionId = 'cli', includeIneligible = false): Promise<SkillRuntimeEntry[]> {
    const snapshot = await this.getSessionSnapshot(sessionId);
    if (includeIneligible) {
      return snapshot.entries;
    }

    return snapshot.entries.filter((entry) => entry.eligible);
  }

  getSourceRoots(): SkillSourceRoots | null {
    return this.sourceRoots;
  }

  async validateSkillPath(targetPath: string): Promise<SkillValidationReport> {
    const report: SkillValidationReport = {
      valid: [],
      issues: [],
    };

    const normalizedTarget = path.resolve(expandHome(targetPath));
    const stat = await safeStat(normalizedTarget);
    if (!stat || !stat.isDirectory()) {
      report.issues.push({
        path: normalizedTarget,
        error: 'Path does not exist or is not a directory',
      });
      return report;
    }

    const rootSkillFile = path.join(normalizedTarget, 'SKILL.md');
    if (await pathExists(rootSkillFile)) {
      const parsed = await parseSkillAtPath(normalizedTarget, 'extra');
      if (parsed.ok) {
        report.valid.push(parsed.value);
      } else {
        report.issues.push({
          path: rootSkillFile,
          error: parsed.error,
        });
      }
    }

    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(normalizedTarget, { withFileTypes: true });
    } catch (error) {
      report.issues.push({
        path: normalizedTarget,
        error: error instanceof Error ? error.message : String(error),
      });
      return report;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDir = path.join(normalizedTarget, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!(await pathExists(skillFile))) {
        continue;
      }

      const parsed = await parseSkillAtPath(skillDir, 'extra');
      if (parsed.ok) {
        report.valid.push(parsed.value);
      } else {
        report.issues.push({
          path: skillFile,
          error: parsed.error,
        });
      }
    }

    return report;
  }

  async loadInstallState(scope: 'workspace' | 'global'): Promise<SkillInstallState> {
    const statePath = this.getInstallStatePath(scope);
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw) as SkillInstallState;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object') {
        return { records: {} };
      }
      return parsed;
    } catch {
      return { records: {} };
    }
  }

  async saveInstallState(scope: 'workspace' | 'global', state: SkillInstallState): Promise<void> {
    const statePath = this.getInstallStatePath(scope);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  getScopeRoot(scope: 'workspace' | 'global'): string {
    if (scope === 'workspace') {
      return path.resolve(expandHome(this.config.security.workspacePath), 'skills');
    }

    return path.join(getKeygateConfigDir(), 'skills');
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private evaluateEntries(): SkillRuntimeEntry[] {
    const context = buildEligibilityContext(this.config);

    return this.loadedSkills
      .map((skill) => {
        const outcome = evaluateSkillEligibility(skill, context);
        return {
          skill,
          eligible: outcome.eligible,
          reason: outcome.reason,
          envOverlay: outcome.envOverlay,
        };
      })
      .sort((left, right) => left.skill.name.localeCompare(right.skill.name));
  }

  private async setupWatchers(): Promise<void> {
    this.stop();

    if (!this.sourceRoots) {
      return;
    }

    const watchTargets = new Set<string>([
      this.sourceRoots.workspaceRoot,
      this.sourceRoots.globalRoot,
      ...this.sourceRoots.bundledRoots,
      ...this.sourceRoots.extraRoots,
      ...this.sourceRoots.pluginRoots,
      ...this.sourceRoots.pluginSkillRoots,
      ...this.loadedSkills.map((skill) => skill.location),
    ]);

    for (const target of watchTargets) {
      const stat = await safeStat(target);
      if (!stat || !stat.isDirectory()) {
        continue;
      }

      try {
        const watcher = watch(target, () => {
          this.scheduleRefresh();
        });

        this.watchers.push(watcher);
      } catch {
        // Ignore unsupported watch targets.
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const debounceMs = this.config.skills?.load.watchDebounceMs ?? 250;
    this.refreshTimer = setTimeout(() => {
      void this.refresh();
    }, debounceMs);
  }

  private getInstallStatePath(scope: 'workspace' | 'global'): string {
    return path.join(this.getScopeRoot(scope), INSTALL_STATE_FILENAME);
  }
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function getKeygateConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']?.trim();
    if (appData) {
      return path.join(appData, 'keygate');
    }

    return path.join(os.homedir(), 'AppData', 'Roaming', 'keygate');
  }

  const xdgConfig = process.env['XDG_CONFIG_HOME']?.trim();
  if (xdgConfig) {
    return path.join(xdgConfig, 'keygate');
  }

  return path.join(os.homedir(), '.config', 'keygate');
}

async function safeStat(targetPath: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
