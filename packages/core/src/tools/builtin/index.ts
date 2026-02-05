export { filesystemTools } from './filesystem.js';
export { shellTools } from './shell.js';
export { sandboxTools } from './sandbox.js';
export { searchTools } from './search.js';
export { browserTools, closeBrowser } from './browser.js';

import { filesystemTools } from './filesystem.js';
import { shellTools } from './shell.js';
import { sandboxTools } from './sandbox.js';
import { searchTools } from './search.js';
import { browserTools } from './browser.js';

/**
 * All built-in tools combined
 */
export const allBuiltinTools = [
  ...filesystemTools,
  ...shellTools,
  ...sandboxTools,
  ...searchTools,
  ...browserTools,
];
