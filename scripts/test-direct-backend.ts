#!/usr/bin/env bun

import Database from "bun:sqlite";
import { config } from "../src/config";

// Simple XOR decrypt
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

console.log("=== Step 1: Get direct_access credentials ===");

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
  console.error("Failed to get direct_access:", await directAccessResponse.text());
  process.exit(1);
}

const directAccess = await directAccessResponse.json() as {
  duo_workflow_service: {
    base_url: string;
    token: string;
  };
};
console.log("✅ Got direct_access credentials:");
console.log(JSON.stringify(directAccess, null, 2));

const workflowServiceUrl = directAccess.duo_workflow_service.base_url;
const workflowServiceToken = directAccess.duo_workflow_service.token;

console.log("\n=== Step 2: Test backend workflow service ===");
console.log(`Backend URL: ${workflowServiceUrl}`);

// Test various endpoints on the backend service
const backendEndpoints = [
  {
    name: "Health check",
    path: "/health",
    method: "GET"
  },
  {
    name: "API info",
    path: "/api/v1/info",
    method: "GET"
  },
  {
    name: "Workflows list",
    path: "/api/v1/workflows",
    method: "GET"
  },
  {
    name: "Create workflow (REST)",
    path: "/api/v1/workflows",
    method: "POST",
    body: {
      goal: "Say hello in Indonesian",
      workflow_definition: "chat",
      environment: "ide"
    }
  },
  {
    name: "Chat completions (OpenAI-style)",
    path: "/v1/chat/completions",
    method: "POST",
    body: {
      model: "claude_sonnet_4_6",
      messages: [{ role: "user", content: "Say hello" }],
      stream: false
    }
  }
];

for (const endpoint of backendEndpoints) {
  console.log(`\n--- Testing: ${endpoint.name} ---`);
  const url = `https://${workflowServiceUrl}${endpoint.path}`;
  console.log(`URL: ${url}`);
  console.log(`Method: ${endpoint.method}`);
  
  try {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${workflowServiceToken}`,
      "Content-Type": "application/json"
    };

    const response = await fetch(url, {
      method: endpoint.method,
      headers,
      body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
      signal: AbortSignal.timeout(10000)
    });

    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log(`Headers:`);
    response.headers.forEach((value, key) => {
      if (!key.startsWith("x-") && key !== "set-cookie") {
        console.log(`  ${key}: ${value}`);
      }
    });

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const data = await response.json();
      console.log(`Response:`);
      console.log(JSON.stringify(data, null, 2).slice(0, 1500));
    } else if (contentType?.includes("text/event-stream")) {
      console.log("🎉 SSE STREAM DETECTED!");
      const text = await response.text();
      console.log(`SSE Response (first 2000 chars):`);
      console.log(text.slice(0, 2000));
    } else {
      const text = await response.text();
      console.log(`Response (text):`);
      console.log(text.slice(0, 1500));
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    if (error.name === "TimeoutError") {
      console.error("  Request timed out after 10 seconds");
    }
  }
}

console.log("\n=== Step 3: Try WebSocket upgrade on backend ===");
try {
  const wsUrl = `wss://${workflowServiceUrl}/api/v1/ws`;
  console.log(`WebSocket URL: ${wsUrl}`);
  
  const ws = new WebSocket(wsUrl, {
    headers: {
      "Authorization": `Bearer ${workflowServiceToken}`
    }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connection timeout"));
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      console.log("✅ WebSocket connected!");
      ws.close();
      resolve(null);
    };

    ws.onerror = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
  });
} catch (error: any) {
  console.error(`WebSocket Error: ${error.message}`);
}

console.log("\n=== Done ===");
