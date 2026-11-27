/** @lintignore Public workspace setup agent configuration model. */
export type { DetectedConfig } from "./agent-config-copying.js";
/** @lintignore Public workspace setup command API. */
/** @lintignore Public workspace setup command API. */
export { configUpdateCommand } from "./config-update-command.js";
/** @lintignore Public workspace setup template update API. */
export {
  detectExistingTools,
  detectNetworkPolicy,
  getUserFileDefinitions,
  hasExistingConfig,
} from "./files/generated-file-definition.js";
export { haveTemplatesChanged } from "./files/template-hashing.js";
/** @lintignore Public workspace setup command API. */
export { initCommand } from "./init-command.js";
/** @lintignore Public workspace setup asset path API. */
export {
  getTemplatesDirectory,
  getToolRegistryPath,
} from "./workspace-asset-paths.js";
