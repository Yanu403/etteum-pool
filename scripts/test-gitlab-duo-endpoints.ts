#!/usr/bin/env bun

import Database from "bun:sqlite";
import { config } from "../src/config";

// Simple XOR decrypt (same as src/utils/crypto.ts)
function decrypt(ciphertext: string): string {
  const key = new TextEncoder().encode(config.encryptionKey);
  const data = new Uint8Array(Buffer.from(ciphertext, "base64"));
  const decrypted = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    decrypted[i] = data[i]! ^ key[i % key.length]!;
  }

  return new TextDecoder().decode(decrypted);
}

// Get first active gitlab-duo account
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

console.log("=== Testing GitLab Duo Account ===");
console.log(`Email: ${account.email}`);
console.log(`Namespace ID: ${tokens.namespaceId}`);
console.log(`Namespace Path: ${tokens.namespacePath}`);
console.log(`Base URL: ${tokens.gitlabBaseUrl}`);
console.log();

// Test endpoints
const endpoints = [
  {
    name: "1. REST Chat Completions",
    url: `${tokens.gitlabBaseUrl}/api/v4/chat/completions`,
    method: "POST",
    body: {
      content: "Hello, can you help me?",
      additional_context: []
    }
  },
  {
    name: "2. Code Suggestions Completions",
    url: `${tokens.gitlabBaseUrl}/api/v4/code_suggestions/completions`,
    method: "POST",
    body: {
      current_line_suffix: "",
      text_before_cursor: "def hello_world():\n    ",
      project_id: null,
      stream: false
    }
  },
  {
    name: "3. Duo Workflows direct_access",
    url: `${tokens.gitlabBaseUrl}/api/v4/ai/duo_workflows/direct_access`,
    method: "POST",
    body: {
      namespace_id: tokens.namespaceId,
      workflow_definition: "chat"
    }
  },
  {
    name: "4. Duo Workflows create workflow",
    url: `${tokens.gitlabBaseUrl}/api/v4/ai/duo_workflows/workflows`,
    method: "POST",
    body: {
      goal: "Say hello",
      workflow_definition: "chat",
      environment: "ide",
      allow_agent_to_request_user: false,
      agent_privileges: [1, 2, 3, 4, 5, 6],
      pre_approved_agent_privileges: [1, 2, 3, 4, 5, 6]
    }
  }
];

for (const endpoint of endpoints) {
  console.log(`\n=== ${endpoint.name} ===`);
  console.log(`URL: ${endpoint.url}`);
  console.log(`Method: ${endpoint.method}`);
  
  try {
    const response = await fetch(endpoint.url, {
      method: endpoint.method,
      headers: {
        "Content-Type": "application/json",
        "Private-Token": pat,
        "User-Agent": "etteum-pool/test"
      },
      body: JSON.stringify(endpoint.body)
    });

    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log(`Headers:`);
    response.headers.forEach((value, key) => {
      console.log(`  ${key}: ${value}`);
    });

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const data = await response.json();
      console.log(`Response:`);
      console.log(JSON.stringify(data, null, 2).slice(0, 2000));
    } else {
      const text = await response.text();
      console.log(`Response (text):`);
      console.log(text.slice(0, 2000));
    }
  } catch (error) {
    console.error(`Error: ${error}`);
  }
}

console.log("\n=== Done ===");
