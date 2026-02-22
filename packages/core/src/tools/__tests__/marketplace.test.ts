import { describe, it, expect, vi, beforeEach } from 'vitest';
import { marketplaceSearchTool, skillInstallTool } from '../builtin/marketplace.js';
import * as marketplace from '../../skills/marketplace.js';
import * as install from '../../skills/install.js';
import * as env from '../../config/env.js';
import { SkillsManager } from '../../skills/manager.js';

vi.mock('../../skills/marketplace.js');
vi.mock('../../skills/install.js');
vi.mock('../../skills/manager.js');
vi.mock('../../config/env.js');

describe('Marketplace Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('marketplaceSearchTool', () => {
    it('returns empty message when no skills found', async () => {
      vi.mocked(marketplace.loadRegistry).mockResolvedValue({ version: 1, entries: {} });
      vi.mocked(marketplace.searchMarketplace).mockReturnValue({
        entries: [],
        total: 0,
      });

      const result = await marketplaceSearchTool.handler({ query: 'unknown' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No skills found');
    });

    it('formats marketplace entries correctly', async () => {
      vi.mocked(marketplace.loadRegistry).mockResolvedValue({ version: 1, entries: {} });
      vi.mocked(marketplace.searchMarketplace).mockReturnValue({
        entries: [
          {
            name: 'test-skill',
            description: 'A test skill',
            version: '1.0.0',
            author: 'tester',
            source: 'https://github.com/tester/skill',
            tags: ['utility', 'test'],
            publishedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            downloads: 100,
            featured: true,
          }
        ],
        total: 1,
      });

      const result = await marketplaceSearchTool.handler({ query: 'test' });
      expect(result.success).toBe(true);
      if (typeof result.output === 'string') {
        expect(result.output).toContain('Found 1 skill(s):');
        expect(result.output).toContain('### test-skill ★');
        expect(result.output).toContain('A test skill [utility, test]');
        expect(result.output).toContain('tester');
        expect(result.output).toContain('100');
        expect(result.output).toContain('https://github.com/tester/skill');
      } else {
        expect.fail('Expected string output');
      }
    });
  });

  describe('skillInstallTool', () => {
    it('installs skill successfully', async () => {
      vi.mocked(env.loadConfigFromEnv).mockReturnValue({} as any);
      vi.mocked(install.installSkillsFromSource).mockResolvedValue(['test-skill']);

      const result = await skillInstallTool.handler({
        source: 'https://github.com/tester/skill',
        scope: 'workspace'
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Successfully installed skill(s): test-skill');
      expect(install.installSkillsFromSource).toHaveBeenCalledWith(
        expect.any(SkillsManager),
        expect.objectContaining({
          source: 'https://github.com/tester/skill',
          scope: 'workspace',
          targetName: '',
          installAll: false,
        })
      );
    });

    it('returns error when installation fails', async () => {
      vi.mocked(env.loadConfigFromEnv).mockReturnValue({} as any);
      vi.mocked(install.installSkillsFromSource).mockRejectedValue(new Error('Git clone failed'));

      const result = await skillInstallTool.handler({
        source: 'invalid-url',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Git clone failed');
    });

    it('handles empty results', async () => {
      vi.mocked(env.loadConfigFromEnv).mockReturnValue({} as any);
      vi.mocked(install.installSkillsFromSource).mockResolvedValue([]);

      const result = await skillInstallTool.handler({
        source: 'https://github.com/tester/empty',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No skills installed');
    });
  });
});
