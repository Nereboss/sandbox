import chalk from "chalk";
import { writeStandardOutput } from "#platform/terminal/index.js";
import { isPromptCancellation } from "#shared/errors/index.js";
import { processFileUpdates } from "./files/file-updating.js";
import {
  detectExistingTools,
  detectNetworkPolicy,
  type FileDefinition,
  getProjectFileDefinitions,
  getUserFileDefinitions,
  hasExistingConfig,
} from "./files/generated-file-definition.js";
import { selectNetworkPolicy } from "./files/network-policy.js";
import {
  computeTemplateHashes,
  saveTemplateHashes,
} from "./files/template-hashing.js";
import { selectTools } from "./tools/tool-selection.js";

interface ConfigUpdateOptions {
  project?: boolean;
}

async function resolveToolIds(
  definitions: FileDefinition[],
  options: ConfigUpdateOptions,
): Promise<string[]> {
  const detected = detectExistingTools(definitions);

  if (detected.hasToolComment) {
    for (const id of detected.unknown) {
      writeStandardOutput(
        chalk.yellow(`ℹ Skipping unknown tool: ${id} (no longer available)`),
      );
    }
    return detected.toolIds;
  }

  if (detected.hasDockerfile) {
    writeStandardOutput(
      chalk.dim("ℹ Could not detect tools from Dockerfile.\n"),
    );
    writeStandardOutput(chalk.bold("Select tools to regenerate Dockerfile:\n"));
    const selectOptions = options.project
      ? { excludeCategories: ["ai-agents" as const], projectLevel: true }
      : {};
    const toolIds = await selectTools(selectOptions);
    writeStandardOutput();
    return toolIds;
  }

  return [];
}

export async function configUpdateCommand(
  options: ConfigUpdateOptions = {},
): Promise<void> {
  try {
    const definitions = options.project
      ? getProjectFileDefinitions()
      : getUserFileDefinitions();

    if (!hasExistingConfig(definitions)) {
      const command = options.project
        ? "sandbox init --project"
        : "sandbox init";
      writeStandardOutput("No existing configuration found.");
      writeStandardOutput(`Run ${chalk.cyan(command)} first.`);
      return;
    }

    writeStandardOutput("Checking for configuration updates...\n");
    const toolIds = await resolveToolIds(definitions, options);
    let policy = detectNetworkPolicy(definitions);
    if (!policy) {
      writeStandardOutput(
        "The Dockerfile has no valid network policy. Select a default to review the generated config.",
      );
      policy = await selectNetworkPolicy();
    }
    const selectedDefinitions = options.project
      ? getProjectFileDefinitions(policy)
      : getUserFileDefinitions(policy);
    const filesToUpdate =
      options.project && !detectExistingTools(definitions).hasDockerfile
        ? selectedDefinitions.filter(
            (definition) => definition.id !== "dockerfile",
          )
        : selectedDefinitions;
    await processFileUpdates(filesToUpdate, toolIds);

    const storedTools = detectExistingTools(selectedDefinitions);
    if (
      !options.project &&
      detectNetworkPolicy(selectedDefinitions) === policy &&
      storedTools.hasToolComment &&
      storedTools.toolIds.length === toolIds.length &&
      toolIds.every((id) => storedTools.toolIds.includes(id))
    ) {
      saveTemplateHashes(computeTemplateHashes(toolIds, policy));
    }

    writeStandardOutput(
      `Done. Run ${chalk.cyan("sandbox build")} if any Dockerfile changed.`,
    );
  } catch (error) {
    if (isPromptCancellation(error)) {
      writeStandardOutput("\nCancelled.");
      return;
    }
    throw error;
  }
}
