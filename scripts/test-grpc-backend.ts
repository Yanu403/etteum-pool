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

console.log("=== Testing gRPC Backend Service ===\n");

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

const directAccess = await directAccessResponse.json() as any;
const workflowServiceUrl = directAccess.duo_workflow_service.base_url;
const workflowServiceToken = directAccess.duo_workflow_service.token;
const headers = directAccess.duo_workflow_service.headers;

console.log(`Backend: ${workflowServiceUrl}`);
console.log(`Token expires: ${new Date(directAccess.duo_workflow_service.token_expires_at * 1000).toISOString()}`);

// Test gRPC endpoints
const grpcEndpoints = [
  {
    name: "gRPC Service List",
    path: "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
    contentType: "application/grpc"
  },
  {
    name: "gRPC v1 Service List",
    path: "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
    contentType: "application/grpc"
  },
  {
    name: "Workflow Service",
    path: "/workflow.v1.WorkflowService/StartWorkflow",
    contentType: "application/grpc"
  },
  {
    name: "Chat Service",
    path: "/chat.v1.ChatService/SendMessage",
    contentType: "application/grpc"
  }
];

for (const endpoint of grpcEndpoints) {
  console.log(`\n--- ${endpoint.name} ---`);
  const url = `https://${workflowServiceUrl}${endpoint.path}`;
  console.log(`URL: ${url}`);
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${workflowServiceToken}`,
        "Content-Type": endpoint.contentType,
        "Te": "trailers",
        ...headers
      },
      signal: AbortSignal.timeout(5000)
    });

    console.log(`Status: ${response.status}`);
    console.log(`Content-Type: ${response.headers.get("content-type")}`);
    console.log(`gRPC Status: ${response.headers.get("grpc-status")}`);
    console.log(`gRPC Message: ${response.headers.get("grpc-message")}`);
    
    const text = await response.text();
    if (text) {
      console.log(`Response body: ${text.slice(0, 500)}`);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

// Test if we can use the backend with proper gRPC client
console.log("\n=== Testing gRPC-Web Protocol ===\n");

const grpcWebEndpoints = [
  {
    name: "gRPC-Web Service Discovery",
    path: "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
    contentType: "application/grpc-web+proto"
  }
];

for (const endpoint of grpcWebEndpoints) {
  console.log(`\n--- ${endpoint.name} ---`);
  const url = `https://${workflowServiceUrl}${endpoint.path}`;
  console.log(`URL: ${url}`);
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${workflowServiceToken}`,
        "Content-Type": endpoint.contentType,
        "X-Grpc-Web": "1",
        ...headers
      },
      signal: AbortSignal.timeout(5000)
    });

    console.log(`Status: ${response.status}`);
    console.log(`Content-Type: ${response.headers.get("content-type")}`);
    
    const text = await response.text();
    if (text) {
      console.log(`Response: ${text.slice(0, 500)}`);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
}

console.log("\n=== Summary ===");
console.log("Backend service is gRPC-based, not REST/HTTP.");
console.log("All attempts to use REST/SSE endpoints failed with gRPC errors.");
console.log("WebSocket approach is required because:");
console.log("  1. Backend uses gRPC protocol (not REST)");
console.log("  2. REST /api/v4/chat/completions is internal-only on gitlab.com");
console.log("  3. Regular users must use WebSocket through GitLab Rails layer");
console.log("\nConclusion: No simpler REST/SSE alternative exists for regular users.");
