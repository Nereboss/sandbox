import chalk from "chalk";
import {
  getProjectConfigPath,
  getProjectDockerfilePath,
} from "#modules/configuration/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists, readTextFile } from "#platform/filesystem/index.js";
import { getRepoRootPath } from "#platform/git/index.js";
import {
  promptSelectionConfirmation,
  writeStandardOutput,
} from "#platform/terminal/index.js";
import {
  createFilesSilently,
  processFileUpdates,
} from "../files/file-updating.js";
import {
  detectExistingTools,
  detectNetworkPolicy,
  getProjectFileDefinitions,
} from "../files/generated-file-definition.js";
import { selectNetworkPolicy } from "../files/network-policy.js";
import { detectProjectCapabilities } from "../tools/detection.js";
import type { ToolDefinition } from "../tools/tool-definition.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";
import { getToolsById, selectTools } from "../tools/tool-selection.js";
import {
  copyBuildContextFiles,
  detectBuildContextFiles,
} from "./build-context-detection.js";
import { displayInitAssistHint } from "./initialization-display.js";

function validateToolIds(toolIds: string[]): string[] {
  const validIds = TOOL_REGISTRY.map((tool) => tool.id);
  const invalidIds = toolIds.filter((id) => !validIds.includes(id));
  if (invalidIds.length > 0) {
    writeStandardOutput(
      chalk.red(`Unknown tool IDs: ${invalidIds.join(", ")}`),
    );
    writeStandardOutput(chalk.dim(`Valid IDs: ${validIds.join(", ")}`));
    throw new Error(`Unknown tool IDs: ${invalidIds.join(", ")}`);
  }
  return toolIds;
}

async function selectProjectTools(
  projectRoot: string,
  registry: ToolDefinition[],
): Promise<string[]> {
  const detectedTools = await detectProjectCapabilities(registry, projectRoot);
  for (const tool of detectedTools) {
    writeStandardOutput(
      chalk.dim(`ℹ Detected project files - ${tool.name} pre-selected`),
    );
  }
  writeStandardOutput(chalk.bold("Configure project capabilities:\n"));
  return selectTools({
    registry,
    projectLevel: true,
    preSelectedIds: detectedTools.map((tool) => tool.id),
  });
}

async function copySelectedBuildContextFiles(
  selectedToolIds: string[],
  projectRoot: string,
  currentDirectory: string,
): Promise<void> {
  const selectedTools = getToolsById(selectedToolIds);
  const detectedFiles = await detectBuildContextFiles(
    selectedTools,
    projectRoot,
  );
  copyBuildContextFiles(detectedFiles, currentDirectory);
}

function displayProjectNextSteps(): void {
  const cwd = getHostEnvironment().currentWorkingDirectory;
  writeStandardOutput(chalk.bold("\nNext steps"));
  writeStandardOutput(`  1. Edit ${chalk.cyan(getProjectConfigPath(cwd))}`);
  writeStandardOutput(
    chalk.dim("     Add project-specific env vars and mounts\n"),
  );
  writeStandardOutput(
    `  2. ${chalk.dim("(Optional)")} Add tools to ${chalk.cyan(getProjectDockerfilePath(cwd))}`,
  );
  writeStandardOutput(`     Then run: ${chalk.dim("sandbox build")}\n`);
  displayInitAssistHint();
}

export async function initializeProject(toolIds?: string[]): Promise<void> {
  const definitions = getProjectFileDefinitions();
  const nonInteractive = toolIds !== undefined;
  const currentDirectory = getHostEnvironment().currentWorkingDirectory;
  if (!nonInteractive) {
    writeStandardOutput(
      chalk.bold("Initialize project-level sandbox configuration.\n"),
    );
    const customizeImage = await promptSelectionConfirmation({
      message: "Customize the project image?",
      default: false,
    });
    if (!customizeImage) {
      const policy = await selectNetworkPolicy(
        detectNetworkPolicy(definitions) ?? undefined,
      );
      const configDefinitions = getProjectFileDefinitions(policy).filter(
        (definition) => definition.id === "config",
      );
      writeStandardOutput();
      const { toolIds: existingToolIds } = detectExistingTools(definitions);
      await processFileUpdates(configDefinitions, existingToolIds);
      writeStandardOutput();
      displayProjectNextSteps();
      return;
    }
  }

  const projectRoot = await getRepoRootPath(currentDirectory);
  const selectedToolIds = nonInteractive
    ? validateToolIds(toolIds)
    : await selectProjectTools(projectRoot, TOOL_REGISTRY);

  const policy = nonInteractive
    ? "restricted"
    : await selectNetworkPolicy(detectNetworkPolicy(definitions) ?? undefined);
  const selectedDefinitions = getProjectFileDefinitions(policy);
  writeStandardOutput();
  if (nonInteractive) {
    const missing = selectedDefinitions.filter((definition) => {
      const filePath = definition.getPath();
      if (!pathExists(filePath)) return true;
      let existing: string;
      try {
        existing = readTextFile(filePath);
      } catch {
        throw new Error(`Failed to read ${filePath}`);
      }
      if (existing !== definition.getTemplate(selectedToolIds)) {
        throw new Error(
          "Project configuration already exists. Run sandbox config update --project to review changes.",
        );
      }
      return false;
    });
    createFilesSilently(missing, selectedToolIds);
  } else {
    await processFileUpdates(selectedDefinitions, selectedToolIds);
    writeStandardOutput();
  }

  await copySelectedBuildContextFiles(
    selectedToolIds,
    projectRoot,
    currentDirectory,
  );
  if (!nonInteractive) displayProjectNextSteps();
}
