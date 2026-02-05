import { chromium, type Browser, type Page } from 'playwright';
import type { Tool, ToolResult } from '../../types.js';

// Singleton browser instance
let browser: Browser | null = null;
let currentPage: Page | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function getPage(): Promise<Page> {
  if (!currentPage || currentPage.isClosed()) {
    const b = await getBrowser();
    currentPage = await b.newPage();
  }
  return currentPage;
}

/**
 * Navigate to a URL
 */
export const navigateTool: Tool = {
  name: 'browser_navigate',
  description: 'Navigate the browser to a URL',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to navigate to',
      },
    },
    required: ['url'],
  },
  requiresConfirmation: false,
  type: 'browser',
  handler: async (args): Promise<ToolResult> => {
    const url = args['url'] as string;
    try {
      const page = await getPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await page.title();
      return { success: true, output: `Navigated to: ${title} (${url})` };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Navigation failed',
      };
    }
  },
};

/**
 * Take a screenshot
 */
export const screenshotTool: Tool = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current page',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to save the screenshot (optional, defaults to temp file)',
      },
      fullPage: {
        type: 'boolean',
        description: 'Whether to take a full page screenshot (default: false)',
      },
    },
    required: [],
  },
  requiresConfirmation: false,
  type: 'browser',
  handler: async (args): Promise<ToolResult> => {
    try {
      const page = await getPage();
      const outputPath = (args['path'] as string) || `/tmp/screenshot-${Date.now()}.png`;
      const fullPage = (args['fullPage'] as boolean) ?? false;
      
      await page.screenshot({ path: outputPath, fullPage });
      return { success: true, output: `Screenshot saved to: ${outputPath}` };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Screenshot failed',
      };
    }
  },
};

/**
 * Click an element
 */
export const clickTool: Tool = {
  name: 'browser_click',
  description: 'Click an element on the page using a CSS selector',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector for the element to click',
      },
    },
    required: ['selector'],
  },
  requiresConfirmation: true,
  type: 'browser',
  handler: async (args): Promise<ToolResult> => {
    const selector = args['selector'] as string;
    try {
      const page = await getPage();
      await page.click(selector, { timeout: 10000 });
      return { success: true, output: `Clicked element: ${selector}` };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Click failed',
      };
    }
  },
};

/**
 * Type text into an element
 */
export const typeTool: Tool = {
  name: 'browser_type',
  description: 'Type text into an input element',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector for the input element',
      },
      text: {
        type: 'string',
        description: 'Text to type',
      },
    },
    required: ['selector', 'text'],
  },
  requiresConfirmation: true,
  type: 'browser',
  handler: async (args): Promise<ToolResult> => {
    const selector = args['selector'] as string;
    const text = args['text'] as string;
    try {
      const page = await getPage();
      await page.fill(selector, text);
      return { success: true, output: `Typed "${text}" into ${selector}` };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Type failed',
      };
    }
  },
};

/**
 * Get page content/text
 */
export const getContentTool: Tool = {
  name: 'browser_get_content',
  description: 'Get the text content of the current page or a specific element',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector for a specific element (optional, defaults to body)',
      },
    },
    required: [],
  },
  requiresConfirmation: false,
  type: 'browser',
  handler: async (args): Promise<ToolResult> => {
    const selector = (args['selector'] as string) || 'body';
    try {
      const page = await getPage();
      const element = await page.$(selector);
      if (!element) {
        return { success: false, output: '', error: `Element not found: ${selector}` };
      }
      const text = await element.innerText();
      // Truncate very long content
      const truncated = text.length > 5000 ? text.slice(0, 5000) + '...(truncated)' : text;
      return { success: true, output: truncated };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to get content',
      };
    }
  },
};

/**
 * Close the browser
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    currentPage = null;
  }
}

export const browserTools: Tool[] = [
  navigateTool,
  screenshotTool,
  clickTool,
  typeTool,
  getContentTool,
];
