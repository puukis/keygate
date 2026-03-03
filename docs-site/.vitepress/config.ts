import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Keygate Docs',
  description: 'Complete technical documentation for installing, operating, and extending Keygate.',
  base: '/keygate/',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: '/assets/banner.png',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/configuration' },
      { text: 'Operations', link: '/operations/deployment' },
      { text: 'Community', link: '/community/contributing' },
      { text: 'GitHub', link: 'https://github.com/puukis/keygate' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Web App', link: '/guide/web-app' },
            { text: 'Plugins', link: '/guide/plugins' },
            { text: 'Channels', link: '/guide/channels' },
            { text: 'WhatsApp', link: '/guide/whatsapp' },
            { text: 'Sessions & Automations', link: '/guide/sessions-and-automations' },
            { text: 'Providers & Models', link: '/guide/providers-and-models' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'Environment Variables', link: '/reference/environment-variables' },
            { text: 'CLI Commands', link: '/reference/cli' },
            { text: 'Plugin SDK', link: '/reference/plugin-sdk' },
            { text: 'Plugin Manifest', link: '/reference/plugin-manifest' },
            { text: 'Plugin Configuration', link: '/reference/plugin-configuration' },
            { text: 'WebSocket Event Reference', link: '/reference/websocket-events' },
            { text: 'Security', link: '/reference/security' },
            { text: 'Glossary', link: '/reference/glossary' },
          ],
        },
      ],
      '/operations/': [
        {
          text: 'Operations',
          items: [
            { text: 'Deployment', link: '/operations/deployment' },
            { text: 'GitHub Pages', link: '/operations/github-pages' },
            { text: 'Docker', link: '/operations/docker' },
            { text: 'CI/CD Workflows', link: '/operations/ci-cd' },
            { text: 'Troubleshooting', link: '/operations/troubleshooting' },
            { text: 'FAQ', link: '/operations/faq' },
          ],
        },
      ],
      '/community/': [
        {
          text: 'Community',
          items: [
            { text: 'Contributing', link: '/community/contributing' },
            { text: 'Release Process', link: '/community/releases' },
            { text: 'Writing Docs', link: '/community/writing-docs' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/puukis/keygate' }],
    footer: {
      message: 'Built with VitePress · Designed as a long-term source of truth.',
      copyright: 'Copyright © Keygate contributors',
    },
    search: {
      provider: 'local',
    },
  },
});
