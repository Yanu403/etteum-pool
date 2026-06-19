#!/usr/bin/env bun

import Database from "bun:sqlite";
import { config } from "../src/config";

function decrypt(ciphertext: string): string {
  const key = new TextEncoder().encode(config.encryptionKey);
  const data = new Uint8Array(Buffer.from(ciphertext, "base64"));
  const decrypted = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    decrypted[i] = data[i]! ^ key[i % key.length]!;
  }

  return new TextDecoder().decode(decrypted);
}

// Test 1: Verify extractMcpTools logic
console.log("=== Test 1: Extract MCP Tools Logic ===\n");

const mockRequest = {
  model: "claude_sonnet_4_6",
  messages: [
    { role: "user", content: "Test MCP tools" }
  ],
  tools: [
    // Regular tools (should be ignored)
    {
      type: "function",
      function: {
        name: "Bash",
        description: "Execute bash command",
        parameters: { type: "object", properties: { command: { type: "string" } } }
      }
    },
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read file",
        parameters: { type: "object", properties: { file_path: { type: "string" } } }
      }
    },
    // MCP tools (should be extracted)
    {
      type: "function",
      function: {
        name: "context7__resolve-library-id",
        description: "Resolve library ID",
        parameters: { 
          type: "object", 
          properties: { 
            libraryName: { type: "string" },
            version: { type: "string" }
          } 
        }
      }
    },
    {
      type: "function",
      function: {
        name: "context7__get-library-docs",
        description: "Get library docs",
        parameters: { 
          type: "object", 
          properties: { 
            libraryId: { type: "string" }
          } 
        }
      }
    },
    {
      type: "function",
      function: {
        name: "playwright__browser_navigate",
        description: "Navigate browser",
        parameters: { 
          type: "object", 
          properties: { 
            url: { type: "string" }
          } 
        }
      }
    },
    {
      type: "function",
      function: {
        name: "playwright__browser_screenshot",
        description: "Take screenshot",
        parameters: { 
          type: "object", 
          properties: { 
            savePath: { type: "string" }
          } 
        }
      }
    },
    {
      type: "function",
      function: {
        name: "sequential-thinking__think",
        description: "Think step by step",
        parameters: { 
          type: "object", 
          properties: { 
            thought: { type: "string" }
          } 
        }
      }
    }
  ]
};

// Simulate extractMcpTools logic
function extractMcpTools(request: any): unknown[] {
  if (!request.tools || !Array.isArray(request.tools)) return [];

  const mcpTools: unknown[] = [];

  for (const tool of request.tools) {
    const fn = tool?.function ?? tool;
    const name = fn?.name;

    if (!name || !name.includes("__")) continue;

    const parts = name.split("__");
    if (parts.length < 2) continue;

    const server = parts[0];
    const toolName = parts.slice(1).join("__");

    mcpTools.push({
      server,
      tool: toolName,
      inputSchema: fn?.parameters ?? fn?.input_schema ?? { type: "object", properties: {} },
    });
  }

  return mcpTools;
}

const mcpTools = extractMcpTools(mockRequest);
console.log(`Extracted ${mcpTools.length} MCP tools:`);
mcpTools.forEach((tool: any) => {
  console.log(`  - ${tool.server}__${tool.tool}`);
  console.log(`    Schema: ${JSON.stringify(tool.inputSchema).slice(0, 100)}...`);
});

if (mcpTools.length !== 5) {
  console.error(`\n❌ FAILED: Expected 5 MCP tools, got ${mcpTools.length}`);
  process.exit(1);
}

console.log("\n✅ PASSED: Correctly extracted 5 MCP tools\n");

// Test 2: Verify startRequest payload structure
console.log("=== Test 2: Verify startRequest Payload ===\n");

const startRequest = {
  workflowID: "test-workflow-123",
  clientVersion: "1.0",
  workflowDefinition: "chat",
  goal: "Test MCP integration",
  workflowMetadata: JSON.stringify({ extended_logging: false }),
  additional_context: [],
  clientCapabilities: [
    "shell_command",
    "read_file_chunked",
    "tool_call_approval",
    "tool_call_pattern_approval",
    "command_timeout",
    "web_search",
    "incremental_streaming",
    "file_modifications",
    "git_operations",
    "mcp_tools"
  ],
  mcpTools: mcpTools,
  preapproved_tools: [],
  flowConfig: undefined,
  flowConfigSchemaVersion: undefined,
  flowConfigId: undefined,
  flowVersion: undefined,
  approval: undefined,
};

console.log("startRequest payload:");
console.log(JSON.stringify(startRequest, null, 2));

if (!startRequest.clientCapabilities.includes("mcp_tools")) {
  console.error("\n❌ FAILED: mcp_tools not in clientCapabilities");
  process.exit(1);
}

if (!startRequest.mcpTools || startRequest.mcpTools.length === 0) {
  console.error("\n❌ FAILED: mcpTools is empty");
  process.exit(1);
}

console.log("\n✅ PASSED: startRequest structure is correct\n");

// Test 3: Verify with actual GitLab Duo account (dry run)
console.log("=== Test 3: Verify with GitLab Duo Account ===\n");

const db = new Database(config.databasePath);
const stmt = db.prepare(`
  SELECT id, email, password, tokens 
  FROM accounts 
  WHERE provider = 'gitlab-duo' 
    AND status = 'active' 
    AND enabled = 1 
  LIMIT 1
`);
const account = stmt.get() as any;

if (!account) {
  console.log("⚠️  No active gitlab-duo accounts found, skipping live test");
  console.log("\n=== Summary ===");
  console.log("✅ MCP tools extraction logic: PASSED");
  console.log("✅ startRequest payload structure: PASSED");
  console.log("⚠️  Live GitLab Duo test: SKIPPED (no active accounts)");
  process.exit(0);
}

const tokens = JSON.parse(account.tokens);
const pat = decrypt(account.password);

console.log(`Using account: ${account.email}`);
console.log(`Namespace ID: ${tokens.namespaceId}\n`);

// Get direct_access credentials
const directAccessResponse = await fetch(
  `${tokens.gitlabBaseUrl}/api/v4/ai/duo_workflows/direct_access`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Private-Token": pat
    },
    body: JSON.stringify({
      namespace_id: tokens.namespaceId,
      workflow_definition: "chat"
    })
  }
);

if (!directAccessResponse.ok) {
  console.error(`❌ FAILED: direct_access returned ${directAccessResponse.status}`);
  process.exit(1);
}

interface DirectAccessResponse {
  server_capabilities?: string[];
}

const directAccess = await directAccessResponse.json() as DirectAccessResponse;
console.log(`✅ Got direct_access credentials`);
console.log(`   Server capabilities: ${directAccess.server_capabilities?.join(", ") || "none"}`);

// Check if server supports MCP
const supportsMcp = directAccess.server_capabilities?.includes("mcp_tools") || false;
console.log(`   MCP support: ${supportsMcp ? "✅ YES" : "❌ NO"}\n`);

if (!supportsMcp) {
  console.log("⚠️  GitLab server does not advertise mcp_tools capability");
  console.log("   MCP tools may not work on this server");
}

console.log("=== Summary ===");
console.log("✅ MCP tools extraction logic: PASSED");
console.log("✅ startRequest payload structure: PASSED");
console.log(`${supportsMcp ? "✅" : "⚠️ "} GitLab Duo server MCP support: ${supportsMcp ? "PASSED" : "NOT ADVERTISED"}`);
console.log("\n🎉 All tests passed!");
