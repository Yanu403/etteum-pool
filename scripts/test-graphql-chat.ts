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

console.log("=== Testing GraphQL AiAction & AiAgenticChat ===\n");

// First, let's get the full AiActionInput schema
console.log("=== 1. Introspect AiActionInput ===\n");

const introspectQuery = `
  query IntrospectAiAction {
    __type(name: "AiActionInput") {
      name
      inputFields {
        name
        description
        type {
          name
          kind
          ofType {
            name
            kind
          }
        }
      }
    }
    __type(name: "AiAgenticChatInput") {
      name
      inputFields {
        name
        description
        type {
          name
          kind
          ofType {
            name
            kind
          }
        }
      }
    }
    __type(name: "AiAction") {
      name
      enumValues {
        name
        description
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
    body: JSON.stringify({ query: introspectQuery })
  });

  if (response.ok) {
    const data = await response.json() as any;
    console.log(JSON.stringify(data.data, null, 2));
  } else {
    const text = await response.text();
    console.error(`Error: ${text.slice(0, 500)}`);
  }
} catch (error: any) {
  console.error(`Error: ${error.message}`);
}

// Try AiAction mutation with different action types
console.log("\n\n=== 2. Test AiAction Mutations ===\n");

const actionTypes = [
  "DUO_CHAT",
  "DUO_CHAT_AGENC",
  "CHAT",
  "AGENTIC_CHAT",
  "DUO_AGENC_CHAT"
];

for (const action of actionTypes) {
  console.log(`--- Testing action: ${action} ---`);
  
  const mutation = `
    mutation testAiAction($action: AiAction!, $content: String!) {
      aiAction(input: { action: $action, content: $content }) {
        clientMutationId
        requestId
        threadId
        errors
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
      body: JSON.stringify({
        query: mutation,
        variables: {
          action,
          content: "Say hello in Indonesian"
        }
      })
    });

    console.log(`Status: ${response.status}`);
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2).slice(0, 800));
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
  }
  console.log();
}

// Try GraphQL Subscription (if supported)
console.log("\n=== 3. Test GraphQL Subscription ===\n");

const subscriptionQuery = `
  subscription aiActionSubscription {
    aiAction {
      clientMutationId
      requestId
      threadId
      errors
    }
  }
`;

console.log("Subscription query (for reference):");
console.log(subscriptionQuery);
console.log("\nNote: GraphQL subscriptions typically require WebSocket connection");
console.log("to /api/graphql with subscription protocol");

// Test GraphQL over HTTP with streaming
console.log("\n=== 4. GraphQL HTTP Streaming ===\n");

const chatMutation = `
  mutation aiAction($input: AiActionInput!) {
    aiAction(input: $input) {
      clientMutationId
      requestId
      threadId
      errors
    }
  }
`;

try {
  const response = await fetch(`${tokens.gitlabBaseUrl}/api/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Private-Token": pat,
      "Accept": "multipart/mixed"
    },
    body: JSON.stringify({
      query: chatMutation,
      variables: {
        input: {
          action: "DUO_CHAT",
          content: "Hello",
          additionalContext: []
        }
      }
    })
  });

  console.log(`Status: ${response.status}`);
  console.log(`Content-Type: ${response.headers.get("content-type")}`);
  
  const text = await response.text();
  console.log(`Response: ${text.slice(0, 500)}`);
} catch (error: any) {
  console.error(`Error: ${error.message}`);
}

console.log("\n=== Done ===");
