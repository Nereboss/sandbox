import {
  getGlobalConfigPath,
  getGlobalDockerfilePath,
  getProjectConfigPath,
  getProjectDockerfilePath,
  type PersistPathInput,
} from "#modules/configuration/index.js";
import { BASE_IMAGE, USER_IMAGE } from "#modules/sandbox-resources/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists, readTextFile } from "#platform/filesystem/index.js";
import {
  readToolIdsFromDockerfile,
  validateToolIds,
} from "../initialization/build-context-detection.js";
import { generateDockerfile } from "../tools/dockerfile-generation.js";
import { resolveTools } from "../tools/tool-resolution.js";
import { injectNamedVolumePersistPaths } from "./config-template-writing.js";
import {
  formatNetworkRules,
  type NetworkPolicy,
  parseNetworkPolicy,
} from "./network-policy.js";
import {
  CONFIG_TOML_TEMPLATE,
  PROJECT_CONFIG_TOML_TEMPLATE,
} from "./template-loading.js";

export interface FileDefinition {
  id: string;
  name: string;
  description?: string;
  getPath: () => string;
  getTemplate: (toolIds: string[]) => string;
}

function networkTemplate(
  template: string,
  policy: NetworkPolicy,
  toolIds: string[],
): string {
  const rules = formatNetworkRules(policy, toolIds);
  return template.replace(/^ {2}# \{\{network_rules\}\}\r?\n/m, () =>
    rules ? `\n${rules}\n` : "",
  );
}

export function detectNetworkPolicy(
  definitions: FileDefinition[],
): NetworkPolicy | null {
  const dockerfile = getDockerfilePath(definitions);
  return dockerfile && pathExists(dockerfile)
    ? parseNetworkPolicy(readTextFile(dockerfile))
    : null;
}

const BEGIN_AGENT_BLOCK = "^ {2}# BEGIN agent:([\\w-]+)\\r?\\n";
const BLOCK_CONTENT = "([\\s\\S]*?)";
const END_AGENT_BLOCK = "^ {2}# END agent:\\1\\r?\\n";
const AGENT_BLOCK = new RegExp(
  BEGIN_AGENT_BLOCK + BLOCK_CONTENT + END_AGENT_BLOCK,
  "gm",
);

function selectAgentConfig(template: string, toolIds: string[]): string {
  const selected = new Set(toolIds);
  return template.replace(AGENT_BLOCK, (match, agent: string) => {
    return selected.has(agent) ? match : "";
  });
}

function collectToolPersistPaths(toolIds: string[]): PersistPathInput[] {
  return resolveTools(toolIds).dependencyClosure.flatMap(
    (tool) => tool.persistPaths ?? [],
  );
}

/**
 * User-level file definitions (used by init and config-update).
 */
export function getUserFileDefinitions(
  policy: NetworkPolicy = "balanced",
): FileDefinition[] {
  return [
    {
      id: "config",
      name: "config.toml",
      description: "Global configuration",
      getPath: getGlobalConfigPath,
      getTemplate: (toolIds) => {
        const template = selectAgentConfig(CONFIG_TOML_TEMPLATE, toolIds);
        return networkTemplate(template, policy, toolIds);
      },
    },
    {
      id: "dockerfile",
      name: "docker/Dockerfile",
      description: "User-level image template",
      getPath: getGlobalDockerfilePath,
      getTemplate: (toolIds) => {
        const resolved = resolveTools(toolIds);
        return generateDockerfile({
          tools: resolved.dependencyClosure,
          baseImage: BASE_IMAGE,
          toolIds: resolved.directSelections.map((tool) => tool.id),
          networkPolicy: policy,
        });
      },
    },
  ];
}

/**
 * Find the Dockerfile path from a set of file definitions.
 * Returns null if no dockerfile definition exists.
 * @testonly
 */
export function getDockerfilePath(
  definitions: FileDefinition[],
): string | null {
  const def = definitions.find((d) => d.id === "dockerfile");
  return def ? def.getPath() : null;
}

/**
 * Check if any file from the definitions already exists on disk.
 */
export function hasExistingConfig(definitions: FileDefinition[]): boolean {
  return definitions.some((def) => pathExists(def.getPath()));
}

/**
 * Detect and validate tool IDs from the Dockerfile referenced in definitions.
 * Provides all info callers need to decide how to handle missing/present tools:
 * - config-update: if !hasToolComment && hasDockerfile -> prompt interactively
 * - init: use toolIds as pre-selection for selectTools (always prompts)
 * - update: just use toolIds directly (never prompts)
 */
export function detectExistingTools(definitions: FileDefinition[]): {
  toolIds: string[];
  unknown: string[];
  hasDockerfile: boolean;
  hasToolComment: boolean;
} {
  const dockerfilePath = getDockerfilePath(definitions);
  if (!dockerfilePath || !pathExists(dockerfilePath)) {
    return {
      toolIds: [],
      unknown: [],
      hasDockerfile: false,
      hasToolComment: false,
    };
  }
  const raw = readToolIdsFromDockerfile(dockerfilePath);
  if (raw === null) {
    return {
      toolIds: [],
      unknown: [],
      hasDockerfile: true,
      hasToolComment: false,
    };
  }
  const { valid, unknown } = validateToolIds(raw);
  return { toolIds: valid, unknown, hasDockerfile: true, hasToolComment: true };
}

/**
 * Project-level file definitions (used by init --project).
 */
function getProjectBaseImage(): string {
  const userDockerfilePath = getGlobalDockerfilePath();
  return pathExists(userDockerfilePath) ? USER_IMAGE : BASE_IMAGE;
}

export function getProjectFileDefinitions(
  policy: NetworkPolicy = "balanced",
): FileDefinition[] {
  return [
    {
      id: "config",
      name: "config.toml",
      description: "Project configuration",
      getPath: () =>
        getProjectConfigPath(getHostEnvironment().currentWorkingDirectory),
      getTemplate: (toolIds) => {
        const toolPaths = collectToolPersistPaths(toolIds);
        const content = networkTemplate(
          PROJECT_CONFIG_TOML_TEMPLATE,
          policy,
          toolIds,
        );
        return injectNamedVolumePersistPaths(content, toolPaths);
      },
    },
    {
      id: "dockerfile",
      name: "docker/Dockerfile",
      description: "Project-specific image",
      getPath: () =>
        getProjectDockerfilePath(getHostEnvironment().currentWorkingDirectory),
      getTemplate: (toolIds) => {
        const resolved = resolveTools(toolIds);
        return generateDockerfile({
          tools: resolved.dependencyClosure,
          baseImage: getProjectBaseImage(),
          toolIds: resolved.directSelections.map((tool) => tool.id),
          networkPolicy: policy,
        });
      },
    },
  ];
}
