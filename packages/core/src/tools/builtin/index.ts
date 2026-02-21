export { filesystemTools } from './filesystem.js';
export { editTools } from './edit.js';
export { shellTools } from './shell.js';
export { sandboxTools } from './sandbox.js';
export { searchTools } from './search.js';
export { browserTools, closeBrowser } from './browser.js';

import { filesystemTools } from './filesystem.js';
import { editTools } from './edit.js';
import { shellTools } from './shell.js';
import { sandboxTools } from './sandbox.js';
import { searchTools } from './search.js';
import { browserTools } from './browser.js';

/**
 * All built-in tools combined
 */
export const allBuiltinTools = [
  ...filesystemTools,
  ...editTools,
  ...shellTools,
  ...sandboxTools,
  ...searchTools,
  ...browserTools,
];
