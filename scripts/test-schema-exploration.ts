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
  console.error("No active gitlab-duo accounts found");
  process.exit(1);
}

const tokens = JSON.parse(account.tokens);
const pat = decrypt(account.password);

console.log("=== Deep Exploration: GraphQL Schema & AI Gateway ===\n");

// Approach 1: GraphQL Schema Introspection - find Duo-related types
console.log("=== 1. GraphQL Schema - Search Duo/AI Types ===\n");

const introspectionQuery = `
  query IntrospectionQuery {
    __schema {
      types {
        name
        description
        fields {
          name
          description
        }
      }
    }
  }
`;

try {
  const response = await fetch(`${tokens.gitlabBaseUrl}/api/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Private-Token": pat
    },
    body: JSON.stringify({ query: introspectionQuery })
  });

  if (response.ok) {
    const data = await response.json() as any;
    
    // Filter for Duo/AI/Chat related types
    const relevantTypes = data.data.__schema.types.filter((type: any) => {
      const name = (type.name || "").toLowerCase();
      return name.includes("duo") || 
             name.includes("chat") || 
             name.includes("ai") ||
             name.includes("assistant");
    });

    console.log(`Found ${relevantTypes.length} relevant types:\n`);
    
    for (const type of relevantTypes.slice(0, 15)) {
      console.log(`Type: ${type.name}`);
      if (type.description) {
        console.log(`  Description: ${type.description}`);
      }
      if (type.fields && type.fields.length > 0) {
        console.log(`  Fields:`);
        for (const field of type.fields.slice(0, 10)) {
          console.log(`    - ${field.name}${field.description ? `: ${field.description}` : ''}`);
        }
      }
      console.log();
    }
  }
} catch (error: any) {
  console.error(`Error: ${error.message}`);
}

// Approach 2: Try AI Gateway directly with proper GitLab headers
console.log("\n=== 2. AI Gateway Direct Access ===\n");

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

if (directAccessResponse.ok) {
  const directAccess = await directAccessResponse.json() as any;
  const gatewayToken = directAccess.gitlab_rails.token;
  
  console.log("Got AI Gateway token");
  
  // Try different AI Gateway endpoints
  const gatewayEndpoints = [
    {
      name: "AI Gateway Chat",
      url: `${tokens.gitlabBaseUrl}/api/v4/ai/chat`,
      body: {
        prompt: "Say hello",
        model: "claude_sonnet_4_6"
      }
    },
    {
      name: "AI Gateway Completion",
      url: `${tokens.gitlabBaseUrl}/api/v4/ai/completion`,
      body: {
        prompt: "Say hello",
        model: "claude_sonnet_4_6"
      }
    }
  ];

  for (const endpoint of gatewayEndpoints) {
    console.log(`\n--- ${endpoint.name} ---`);
    console.log(`URL: ${endpoint.url}`);
    
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${gatewayToken}`,
          "X-Gitlab-Authentication-Type": "token"
        },
        body: JSON.stringify(endpoint.body)
      });

      console.log(`Status: ${response.status}`);
      const text = await response.text();
      console.log(`Response: ${text.slice(0, 500)}`);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
    }
  }
}

// Approach 3: Check ActionCable/Subscriptions endpoint
console.log("\n\n=== 3. ActionCable/Subscriptions Check ===\n");

const cableEndpoints = [
  "/cable",
  "/-/cable",
  "/api/v4/cable",
  "/websocket"
];

for (const endpoint of cableEndpoints) {
  console.log(`Testing: ${endpoint}`);
  try {
    const response = await fetch(`${tokens.gitlabBaseUrl}${endpoint}`, {
      headers: {
        "Private-Token": pat,
        "Upgrade": "websocket",
        "Connection": "Upgrade"
      }
    });
    console.log(`  Status: ${response.status}`);
  } catch (error: any) {
    console.log(`  Error: ${error.message}`);
  }
}

// Approach 4: Try streaming with Transfer-Encoding
console.log("\n\n=== 4. Streaming Endpoint Patterns ===\n");

const streamingPatterns = [
  "/api/v4/chat/stream",
  "/api/v4/duo/stream",
  "/api/v4/ai/stream",
  "/api/v4/chat/completions/stream"
];

for (const pattern of streamingPatterns) {
  console.log(`Testing: ${pattern}`);
  try {
    const response = await fetch(`${tokens.gitlabBaseUrl}${pattern}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Private-Token": pat,
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({ content: "test", stream: true })
    });
    console.log(`  Status: ${response.status}`);
    if (response.status !== 404) {
      const text = await response.text();
      console.log(`  Response: ${text.slice(0, 200)}`);
    }
  } catch (error: any) {
    console.log(`  Error: ${error.message}`);
  }
}

console.log("\n=== Done ===");
