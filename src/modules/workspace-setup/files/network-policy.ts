import { selectOne, writeStandardOutput } from "#platform/terminal/index.js";
import { resolveTools } from "../tools/tool-resolution.js";

export type NetworkPolicy = "restricted" | "balanced" | "broad";

const BALANCED_HOSTS = [
  "github.com:{22,80,443}",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "gitlab.com:{22,80,443}",
  "bitbucket.org:{22,80,443}",
];

const BROAD_HOSTS = [
  "*.github.com",
  "*.githubusercontent.com",
  "*.gitlab.com",
  "*.bitbucket.org",
  "*.docker.io",
  "*.docker.com",
  "*.gcr.io",
  "ghcr.io",
  "public.ecr.aws",
  "*.google.com",
  "*.googleapis.com",
  "*.azure.com",
  "*.microsoft.com",
  "*.microsoftonline.com",
  "*.visualstudio.com",
  "*.amazonaws.com",
  "*.api.aws",
  "*.k8s.io",
  "*.hashicorp.com",
  "*.jdx.dev",
  "*.playwright.dev",
  "*.sourceforge.net",
  "*.packagecloud.io",
  "*.json-schema.org",
  "*.schemastore.org",
];

interface NetworkRuleGroup {
  label: string;
  hosts: string[];
}

function getToolRuleGroups(toolIds: string[]): NetworkRuleGroup[] {
  const toolNamesByHost = new Map<string, string[]>();
  for (const tool of resolveTools(toolIds).dependencyClosure) {
    for (const host of tool.allowNetwork ?? []) {
      const names = toolNamesByHost.get(host) ?? [];
      names.push(tool.name);
      toolNamesByHost.set(host, names);
    }
  }

  const toolGroups = Map.groupBy(toolNamesByHost, ([, names]) =>
    names.join(", "),
  );
  return Array.from(toolGroups, ([label, rules]) => ({
    label,
    hosts: rules.map(([host]) => host),
  }));
}

function getPolicyRuleGroups(
  policy: NetworkPolicy,
  toolGroups: NetworkRuleGroup[],
): NetworkRuleGroup[] {
  const policyGroups = [
    {
      label: "Balanced: common Git hosts",
      hosts: policy === "restricted" ? [] : BALANCED_HOSTS,
    },
    {
      label: "Broad: shared cloud and developer services",
      hosts: policy === "broad" ? BROAD_HOSTS : [],
    },
  ];
  const seen = new Set(toolGroups.flatMap((group) => group.hosts));
  const groups: NetworkRuleGroup[] = [];
  for (const { label, hosts } of policyGroups) {
    const newHosts = hosts.filter((host) => {
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    });
    if (newHosts.length > 0) groups.push({ label, hosts: newHosts });
  }
  return groups;
}

export function formatNetworkRules(
  policy: NetworkPolicy,
  toolIds: string[],
): string {
  const toolGroups = getToolRuleGroups(toolIds);
  const groups = [...toolGroups, ...getPolicyRuleGroups(policy, toolGroups)];
  return groups
    .map(({ label, hosts }) =>
      [`  # ${label}`, ...hosts.map((host) => `  "${host}",`)].join("\n"),
    )
    .join("\n\n");
}

export function parseNetworkPolicy(content: string): NetworkPolicy | null {
  const match =
    /^# Base network policy:[ \t]*(restricted|balanced|broad)[ \t]*\r?$/m.exec(
      content,
    );
  const value = match?.[1];
  return value === "restricted" || value === "balanced" || value === "broad"
    ? value
    : null;
}

export async function selectNetworkPolicy(
  initial?: NetworkPolicy,
): Promise<NetworkPolicy> {
  writeStandardOutput(
    "Network access can send data out of the sandbox. Edit allow_network in config.toml later, or review a config update.",
  );
  return selectOne({
    message: "Choose a network default:",
    default: initial ?? "balanced",
    choices: [
      {
        value: "restricted",
        name: "Restricted: selected tools only. Workflows may need extra hosts.",
      },
      {
        value: "balanced",
        name: "Balanced: selected tools and common Git hosts. Repositories can receive data.",
      },
      {
        value: "broad",
        name: "Broad: shared cloud and hosting wildcards. Weakest boundary, including user-controlled services.",
      },
    ],
  });
}
