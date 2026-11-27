import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadTomlConfig } from "#modules/configuration/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";
import type { FileDefinition } from "./generated-file-definition.js";
import {
  detectExistingTools,
  detectNetworkPolicy,
  getDockerfilePath,
  getProjectFileDefinitions,
  getUserFileDefinitions,
  hasExistingConfig,
} from "./generated-file-definition.js";

describe("file-definitions", () => {
  describe("getUserFileDefinitions", () => {
    it("adds only the selected agent-specific network domains", () => {
      const configDef = getUserFileDefinitions("restricted")[0];
      const cases = [
        {
          toolId: "claude",
          included: ["api.anthropic.com", "claude.ai", "platform.claude.com"],
          excluded: [
            "api.business.githubcopilot.com",
            "opencode.ai",
            "models.dev",
          ],
        },
        {
          toolId: "copilot",
          included: ["api.business.githubcopilot.com"],
          excluded: [
            "api.anthropic.com",
            "claude.ai",
            "opencode.ai",
            "models.dev",
          ],
        },
        {
          toolId: "opencode",
          included: ["opencode.ai", "models.dev"],
          excluded: [
            "api.anthropic.com",
            "claude.ai",
            "api.business.githubcopilot.com",
          ],
        },
      ];

      for (const testCase of cases) {
        const content = configDef?.getTemplate([testCase.toolId]);
        const config = parseToml(content ?? "") as { allow_network: string[] };
        expect(config.allow_network).toEqual(
          expect.arrayContaining(testCase.included),
        );
        for (const domain of testCase.excluded) {
          expect(config.allow_network).not.toContain(domain);
        }
      }
    });

    const agentSelections = [
      { name: "no agents", selected: [] },
      { name: "Codex", selected: ["codex"] },
      {
        name: "Claude, OpenCode, Pi, and Copilot",
        selected: ["claude", "opencode", "pi", "copilot"],
      },
    ];

    it.each(agentSelections)("keeps markers only for $name", ({ selected }) => {
      const configDef = getUserFileDefinitions()[0];
      if (!configDef) throw new Error("Missing user config definition");
      const generated = configDef.getTemplate(selected);
      const agents = ["claude", "codex", "opencode", "pi", "copilot"];
      const unselected = agents.filter((agent) => !selected.includes(agent));

      for (const agent of selected) {
        expect(generated).toContain(`# BEGIN agent:${agent}`);
        expect(generated).toContain(`# END agent:${agent}`);
      }
      for (const agent of unselected) {
        expect(generated).not.toContain(`# BEGIN agent:${agent}`);
        expect(generated).not.toContain(`# END agent:${agent}`);
      }
    });

    it.each(agentSelections)("limits integrations to $name", ({ selected }) => {
      const configDef = getUserFileDefinitions()[0];
      if (!configDef) throw new Error("Missing user config definition");
      const agents = {
        claude: { path: "~/.claude", setting: "~/.claude/settings.json" },
        codex: { path: "~/.codex", setting: "~/.codex/AGENTS.md" },
        opencode: {
          path: "~/.local/share/opencode/auth.json",
          setting: "~/.config/opencode/*",
        },
        pi: { path: "~/.pi", setting: "~/.pi/agent/*" },
        copilot: { path: "~/.copilot", setting: "~/.copilot/config.json" },
      };
      const config = parseToml(configDef.getTemplate(selected)) as {
        settings: (string | { path: string })[];
        persist_paths: { path: string }[];
      };
      const integrations = Object.entries(agents);
      const selectedIntegrations = integrations.filter(([agent]) =>
        selected.includes(agent),
      );
      const unselectedIntegrations = integrations.filter(
        ([agent]) => !selected.includes(agent),
      );
      const persistPaths = config.persist_paths.map((item) => item.path);

      for (const [, integration] of selectedIntegrations) {
        expect(persistPaths).toContain(integration.path);
        expect(config.settings).toContain(integration.setting);
      }
      for (const [, integration] of unselectedIntegrations) {
        expect(persistPaths).not.toContain(integration.path);
        expect(config.settings).not.toContain(integration.setting);
      }
    });

    it.each(agentSelections)(
      "keeps host skills read-only with $name",
      ({ selected }) => {
        const configDef = getUserFileDefinitions()[0];
        if (!configDef) throw new Error("Missing user config definition");
        const config = parseToml(configDef.getTemplate(selected)) as {
          mounts: string[];
        };
        expect(config.mounts).toContain("~/.agents/skills:ro");
        expect(config.mounts).not.toContain("~/.agents:rw");
      },
    );

    const agentExtras = [
      {
        agent: "claude",
        persistPaths: ["~/.claude.json", "~/.claude/.credentials.json"],
        settings: [],
        mounts: ["~/.agents/skills:~/.claude/skills:ro", "~/.claude/ide:ro"],
      },
      {
        agent: "codex",
        persistPaths: [],
        settings: ["~/.codex/config.toml"],
        mounts: [
          "~/.agents/skills:~/.codex/skills:ro",
          "~/.codex/auth.json:ro",
        ],
      },
    ];

    it.each(agentExtras)(
      "includes $agent extras only when selected",
      (extras) => {
        function generateConfig(agents: string[]) {
          const configDef = getUserFileDefinitions()[0];
          if (!configDef) throw new Error("Missing user config definition");
          const config = parseToml(configDef.getTemplate(agents)) as {
            mounts: string[];
            settings: (string | { path: string })[];
            persist_paths: { path: string }[];
          };
          return {
            mounts: config.mounts,
            settings: config.settings.flatMap((item) =>
              typeof item === "string" ? [] : [item.path],
            ),
            persistPaths: config.persist_paths.map((item) => item.path),
          };
        }
        const selected = generateConfig([extras.agent]);
        const unselected = generateConfig([]);
        for (const path of extras.persistPaths) {
          expect(selected.persistPaths).toContain(path);
          expect(unselected.persistPaths).not.toContain(path);
        }
        for (const path of extras.settings) {
          expect(selected.settings).toContain(path);
          expect(unselected.settings).not.toContain(path);
        }
        for (const mount of extras.mounts) {
          expect(selected.mounts).toContain(mount);
          expect(unselected.mounts).not.toContain(mount);
        }
      },
    );

    it("paths point to the scoped sandbox config dir", () => {
      const configRoot = "/test/scoped-sandbox-config";
      const paths = runWithTestLogger(
        () =>
          getUserFileDefinitions().map((definition) => definition.getPath()),
        { variables: { SANDBOX_CONFIG_DIR: configRoot } },
      );

      expect(paths).toEqual([
        path.join(configRoot, "config.toml"),
        path.join(configRoot, "docker", "Dockerfile"),
      ]);
    });
  });

  describe("network defaults", () => {
    function domains(
      policy: "restricted" | "balanced" | "broad",
      tools: string[],
    ): string[] {
      const definition = getUserFileDefinitions(policy)[0];
      if (!definition) throw new Error("Missing config definition");
      return (
        parseToml(definition.getTemplate(tools)) as { allow_network: string[] }
      ).allow_network;
    }

    it("restricts access to selected agents and tool dependencies", () => {
      expect(domains("restricted", [])).toEqual([]);
      const selected = domains("restricted", [
        "claude",
        "codex",
        "copilot",
        "pnpm",
      ]);
      expect(selected).toEqual(
        expect.arrayContaining([
          "api.anthropic.com",
          "platform.claude.com",
          "api.openai.com",
          "api.business.githubcopilot.com",
          "registry.npmjs.org",
        ]),
      );
      expect(selected).not.toContain("opencode.ai");
      expect(selected).not.toContain("index.crates.io");
      expect(selected).toHaveLength(new Set(selected).size);
    });

    it.each([
      ["user", getUserFileDefinitions],
      ["project", getProjectFileDefinitions],
    ] as const)(
      "labels tool and policy rules in the %s config",
      (_, definitions) => {
        const [definition] = definitions("broad");
        if (!definition) throw new Error("Missing config definition");
        const content = definition.getTemplate([
          "claude",
          "node",
          "bun",
          "copilot",
        ]);
        expect(content).toContain('  # Claude Code\n  "api.anthropic.com",');
        expect(content).toContain(
          '  # Node.js + npm, Bun\n  "registry.npmjs.org",',
        );
        expect(content).toContain(
          '  # Balanced: common Git hosts\n  "github.com:{22,80,443}",',
        );
        expect(content).toContain(
          '  # Broad: shared cloud and developer services\n  "*.github.com",',
        );
        const { allow_network } = parseToml(content) as {
          allow_network: string[];
        };
        expect(
          allow_network.filter((host) => host === "registry.npmjs.org"),
        ).toHaveLength(1);
        expect(
          allow_network.filter((host) => host === "api.github.com"),
        ).toHaveLength(1);
      },
    );

    it("adds only documented convenience hosts for each policy", () => {
      const blockedWildcards = [
        "*.github.com",
        "*.githubusercontent.com",
        "*.amazonaws.com",
        "*.googleapis.com",
        "*.google.com",
        "*.azure.com",
        "*.microsoft.com",
      ];
      const restricted = domains("restricted", []);
      const balanced = domains("balanced", []);
      const broad = domains("broad", []);
      expect(balanced).toEqual(
        expect.arrayContaining(["github.com:{22,80,443}", "api.github.com"]),
      );
      for (const host of blockedWildcards) {
        expect(restricted).not.toContain(host);
        expect(balanced).not.toContain(host);
        expect(broad).toContain(host);
      }
    });

    it("allows Gradle hosts without opening GitHub access in Restricted", () => {
      const selected = domains("restricted", ["java", "gradle"]);
      expect(selected).toEqual([
        "repo.maven.apache.org",
        "plugins.gradle.org",
        "services.gradle.org",
      ]);
      for (const host of ["services.gradle.org", "plugins.gradle.org"]) {
        expect(domains("restricted", ["java", "maven"])).not.toContain(host);
      }
    });

    it.each(["balanced", "broad"] as const)(
      "%s allows Gradle wrapper downloads and plugins only with Gradle selected",
      (policy) => {
        const selected = domains(policy, ["java", "gradle"]);
        for (const host of ["services.gradle.org", "plugins.gradle.org"]) {
          expect(selected).toContain(host);
          expect(domains(policy, ["java", "maven"])).not.toContain(host);
        }
        expect(selected).toEqual(
          expect.arrayContaining([
            "github.com:{22,80,443}",
            "release-assets.githubusercontent.com",
          ]),
        );
      },
    );

    it("stores and detects each policy and validates generated rules", () => {
      const root = createTestDir("network-policy");
      try {
        for (const policy of ["restricted", "balanced", "broad"] as const) {
          const [config, dockerfile] = getUserFileDefinitions(policy);
          if (!config || !dockerfile) throw new Error("Missing definitions");
          const configPath = path.join(root, "config.toml");
          const dockerPath = path.join(root, "Dockerfile");
          fs.writeFileSync(
            configPath,
            config.getTemplate(["claude", "gradle"]),
          );
          fs.writeFileSync(
            dockerPath,
            dockerfile.getTemplate(["claude", "gradle"]),
          );
          expect(
            runWithTestLogger(() => loadTomlConfig(configPath)),
          ).not.toBeNull();
          expect(
            detectNetworkPolicy([{ ...dockerfile, getPath: () => dockerPath }]),
          ).toBe(policy);
        }
      } finally {
        cleanupTestDir(root);
      }
    });
  });

  describe("getDockerfilePath", () => {
    it("returns path when dockerfile definition is present", () => {
      const defs: FileDefinition[] = [
        {
          id: "config",
          name: "config.toml",
          getPath: () => "/tmp/config.toml",
          getTemplate: () => "",
        },
        {
          id: "dockerfile",
          name: "Dockerfile",
          getPath: () => "/tmp/docker/Dockerfile",
          getTemplate: () => "",
        },
      ];
      expect(getDockerfilePath(defs)).toBe("/tmp/docker/Dockerfile");
    });

    it("returns null when no dockerfile definition exists", () => {
      const defs: FileDefinition[] = [
        {
          id: "config",
          name: "config.toml",
          getPath: () => "/tmp/config.toml",
          getTemplate: () => "",
        },
      ];
      expect(getDockerfilePath(defs)).toBeNull();
    });
  });

  describe("hasExistingConfig", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestDir("file-defs-config");
    });

    afterEach(() => {
      cleanupTestDir(testDir);
    });

    it("returns false when no files exist", () => {
      const defs: FileDefinition[] = [
        {
          id: "config",
          name: "config.toml",
          getPath: () => path.join(testDir, "nonexistent.toml"),
          getTemplate: () => "",
        },
      ];
      expect(hasExistingConfig(defs)).toBe(false);
    });

    it("returns true when any file exists", () => {
      const filePath = path.join(testDir, "config.toml");
      fs.writeFileSync(filePath, "test");
      const defs: FileDefinition[] = [
        {
          id: "config",
          name: "config.toml",
          getPath: () => filePath,
          getTemplate: () => "",
        },
        {
          id: "dockerfile",
          name: "Dockerfile",
          getPath: () => path.join(testDir, "nonexistent"),
          getTemplate: () => "",
        },
      ];
      expect(hasExistingConfig(defs)).toBe(true);
    });
  });

  describe("detectExistingTools", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestDir("file-defs-detect");
    });

    afterEach(() => {
      cleanupTestDir(testDir);
    });

    function makeDefs(dockerfilePath: string): FileDefinition[] {
      return [
        {
          id: "config",
          name: "config.toml",
          getPath: () => path.join(testDir, "config.toml"),
          getTemplate: () => "",
        },
        {
          id: "dockerfile",
          name: "Dockerfile",
          getPath: () => dockerfilePath,
          getTemplate: () => "",
        },
      ];
    }

    it("returns hasDockerfile: false when no Dockerfile exists", () => {
      const defs = makeDefs(path.join(testDir, "nonexistent"));
      const result = detectExistingTools(defs);
      expect(result).toEqual({
        toolIds: [],
        unknown: [],
        hasDockerfile: false,
        hasToolComment: false,
      });
    });

    it("returns hasDockerfile: true, hasToolComment: false when Dockerfile has no comment", () => {
      const dockerfilePath = path.join(testDir, "Dockerfile");
      fs.writeFileSync(dockerfilePath, "FROM base:latest\nRUN echo hello");
      const defs = makeDefs(dockerfilePath);
      const result = detectExistingTools(defs);
      expect(result.hasDockerfile).toBe(true);
      expect(result.hasToolComment).toBe(false);
      expect(result.toolIds).toEqual([]);
    });

    it("returns validated toolIds and unknown IDs when comment exists", () => {
      const dockerfilePath = path.join(testDir, "Dockerfile");
      const validTool = TOOL_REGISTRY[0];
      if (!validTool) throw new Error("No tools in registry");
      fs.writeFileSync(
        dockerfilePath,
        `# Tools: ${validTool.id},fake-tool\nFROM base:latest`,
      );
      const defs = makeDefs(dockerfilePath);
      const result = detectExistingTools(defs);
      expect(result.hasDockerfile).toBe(true);
      expect(result.hasToolComment).toBe(true);
      expect(result.toolIds).toContain(validTool.id);
      expect(result.unknown).toEqual(["fake-tool"]);
    });

    it("returns empty toolIds for Tools comment with only unknown IDs", () => {
      const dockerfilePath = path.join(testDir, "Dockerfile");
      fs.writeFileSync(
        dockerfilePath,
        "# Tools: totally-fake,also-fake\nFROM base:latest",
      );
      const defs = makeDefs(dockerfilePath);
      const result = detectExistingTools(defs);
      expect(result.toolIds).toEqual([]);
      expect(result.unknown).toEqual(["totally-fake", "also-fake"]);
      expect(result.hasToolComment).toBe(true);
    });
  });

  describe("getProjectFileDefinitions", () => {
    const packageHosts = [
      { tools: ["node"], hosts: ["registry.npmjs.org"] },
      { tools: ["bun"], hosts: ["registry.npmjs.org"] },
      { tools: ["pnpm"], hosts: ["registry.npmjs.org"] },
      { tools: ["python"], hosts: ["pypi.org", "files.pythonhosted.org"] },
      { tools: ["uv"], hosts: ["pypi.org", "files.pythonhosted.org"] },
      { tools: ["go"], hosts: ["proxy.golang.org", "sum.golang.org"] },
      { tools: ["rust"], hosts: ["index.crates.io", "static.crates.io"] },
      { tools: ["maven"], hosts: ["repo.maven.apache.org"] },
      { tools: ["gradle"], hosts: ["repo.maven.apache.org"] },
      { tools: ["dotnet"], hosts: ["api.nuget.org"] },
      { tools: ["dotnet-tools"], hosts: ["api.nuget.org"] },
    ];

    it.each(packageHosts)(
      "adds package hosts for $tools",
      ({ tools, hosts }) => {
        const definition = getProjectFileDefinitions()[0];
        if (!definition) throw new Error("Missing project config definition");
        const config = parseToml(definition.getTemplate(tools)) as {
          allow_network: string[];
        };
        expect(config.allow_network).toEqual(expect.arrayContaining(hosts));
        expect(config.allow_network).toHaveLength(
          new Set(config.allow_network).size,
        );
      },
    );

    it("does not add unrelated package hosts to a project", () => {
      const definition = getProjectFileDefinitions()[0];
      if (!definition) throw new Error("Missing project config definition");
      const config = parseToml(definition.getTemplate(["node"])) as {
        allow_network: string[];
      };
      expect(config.allow_network).toContain("registry.npmjs.org");
      expect(config.allow_network).not.toContain("index.crates.io");
      expect(config.allow_network).not.toContain("pypi.org");
    });

    let testDir: string;

    beforeEach(() => {
      testDir = createTestDir("project-file-defs");
    });

    afterEach(() => cleanupTestDir(testDir));

    function scoped<T>(operation: () => T): T {
      return runWithTestLogger(operation, {
        currentWorkingDirectory: testDir,
        homeDirectory: path.join(testDir, "home"),
        variables: {
          SANDBOX_CONFIG_DIR: path.join(testDir, "sandbox-config"),
        },
      });
    }

    it("extends the base image without a user Dockerfile", () => {
      const content = scoped(
        () => getProjectFileDefinitions()[1]?.getTemplate([]) ?? "",
      );
      expect(content).toContain("FROM sandbox-base:latest");
    });

    it("extends the user image when its Dockerfile exists", () => {
      const dockerDirectory = path.join(testDir, "sandbox-config", "docker");
      fs.mkdirSync(dockerDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(dockerDirectory, "Dockerfile"),
        "FROM sandbox-base:latest\n",
      );
      const content = scoped(
        () => getProjectFileDefinitions()[1]?.getTemplate([]) ?? "",
      );
      expect(content).toContain("FROM sandbox-user:latest");
    });

    it("maps paths below the scoped current directory", () => {
      const paths = scoped(() =>
        getProjectFileDefinitions().map((definition) => definition.getPath()),
      );
      expect(paths).toEqual([
        path.join(testDir, ".sandbox", "config.toml"),
        path.join(testDir, ".sandbox", "docker", "Dockerfile"),
      ]);
    });
  });
});
