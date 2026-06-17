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

console.log("=== Testing GraphQL & Alternative Approaches ===\n");

// Test 1: GraphQL API for Duo Chat
console.log("=== 1. GraphQL API - Duo Chat ===\n");

const graphqlQueries = [
  {
    name: "Duo Chat Mutation",
    query: `
      mutation duoChatSubmitMessage($content: String!) {
        duoChatSubmitMessage(content: $content) {
          chat {
            id
            messages {
              id
              content
              role
            }
          }
          errors
        }
      }
    `,
    variables: { content: "Say hello" }
  },
  {
    name: "Duo Chat Query",
    query: `
      query duoChat {
        duoChat {
          id
          messages {
            id
            content
            role
          }
        }
      }
    `
  },
  {
    name: "AI Action",
    query: `
      mutation aiAction($content: String!) {
        aiAction(input: { action: DUO_CHAT, content: $content }) {
          result
          errors
        }
      }
    `,
    variables: { content: "Hello" }
  }
];

for (const gqlQuery of graphqlQueries) {
  console.log(`--- ${gqlQuery.name} ---`);
  
  try {
    const response = await fetch(`${tokens.gitlabBaseUrl}/api/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Private-Token": pat
      },
      body: JSON.stringify({
        query: gqlQuery.query,
        variables: gqlQuery.variables || {}
      })
    });

    console.log(`Status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log(`Response:`);
      console.log(JSON.stringify(data, null, 2).slice(0, 1500));
    } else {
      const text = await response.text();
      console.log(`Error: ${text.slice(0, 500)}`);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
  console.log();
}

// Test 2: Check if there's a newer API version
console.log("=== 2. Alternative API Versions ===\n");

const altEndpoints = [
  "/api/v5/chat/completions",
  "/api/v4/ai/chat/completions",
  "/api/v4/duo/chat/completions",
  "/api/v4/ai_assistant/chat",
  "/api/v4/conversations",
  "/internal/api/v4/chat/completions"
];

for (const endpoint of altEndpoints) {
  console.log(`Testing: ${endpoint}`);
  try {
    const response = await fetch(`${tokens.gitlabBaseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Private-Token": pat
      },
      body: JSON.stringify({ content: "test" })
    });
    console.log(`  Status: ${response.status} ${response.statusText}`);
    if (response.status !== 404 && response.status !== 401) {
      const text = await response.text();
      console.log(`  Response: ${text.slice(0, 200)}`);
    }
  } catch (error: any) {
    console.error(`  Error: ${error.message}`);
  }
}

// Test 3: Check GitLab Duo features/status
console.log("\n=== 3. GitLab Duo Feature Flags ===\n");

try {
  const response = await fetch(`${tokens.gitlabBaseUrl}/api/v4/duo/features`, {
    headers: { "Private-Token": pat }
  });
  console.log(`Status: ${response.status}`);
  if (response.ok) {
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2).slice(0, 1000));
  }
} catch (error: any) {
  console.error(`Error: ${error.message}`);
}

// Test 4: Check namespace Duo settings
console.log("\n=== 4. Namespace Duo Settings ===\n");

try {
  const response = await fetch(
    `${tokens.gitlabBaseUrl}/api/v4/groups/${tokens.namespacePath}/duo_settings`,
    { headers: { "Private-Token": pat } }
  );
  console.log(`Status: ${response.status}`);
  if (response.ok) {
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2).slice(0, 1000));
  }
} catch (error: any) {
  console.error(`Error: ${error.message}`);
}

console.log("\n=== Done ===");
