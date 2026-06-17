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

console.log("=== Introspect Specific AI Types ===\n");

// Introspect the exact structure of key types
const introspectionQuery = `
  query IntrospectSpecificTypes {
    AiActionInput: __type(name: "AiActionInput") {
      name
      kind
      inputFields {
        name
        description
        type {
          name
          kind
          ofType {
            name
            kind
            ofType {
              name
              kind
            }
          }
        }
      }
    }
    
    AiAgenticChatInput: __type(name: "AiAgenticChatInput") {
      name
      kind
      inputFields {
        name
        description
        type {
          name
          kind
          ofType {
            name
            kind
            ofType {
              name
              kind
            }
          }
        }
      }
    }
    
    AiAction: __type(name: "AiAction") {
      name
      kind
      enumValues {
        name
        description
      }
    }
    
    AiActionPayload: __type(name: "AiActionPayload") {
      name
      kind
      fields {
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
    console.log(JSON.stringify(data.data, null, 2));
    
    // Analyze the results
    console.log("\n\n=== Analysis ===\n");
    
    const aiActionInput = data.data?.AiActionInput;
    console.log("AiActionInput fields:");
    if (aiActionInput?.inputFields) {
      aiActionInput.inputFields.forEach((field: any) => {
        console.log(`  - ${field.name}: ${field.description || 'No description'}`);
        console.log(`    Type: ${JSON.stringify(field.type)}`);
      });
    } else {
      console.log("  No input fields found");
    }
    
    console.log("\nAiAgenticChatInput fields:");
    const agenticChatInput = data.data?.AiAgenticChatInput;
    if (agenticChatInput?.inputFields) {
      agenticChatInput.inputFields.forEach((field: any) => {
        console.log(`  - ${field.name}: ${field.description || 'No description'}`);
        console.log(`    Type: ${JSON.stringify(field.type)}`);
      });
    } else {
      console.log("  No input fields found or type doesn't exist");
    }
    
    console.log("\nAiAction enum values:");
    const aiAction = data.data?.AiAction;
    if (aiAction?.enumValues) {
      aiAction.enumValues.forEach((val: any) => {
        console.log(`  - ${val.name}: ${val.description || 'No description'}`);
      });
    } else {
      console.log("  No enum values found");
    }
    
  } else {
    const text = await response.text();
    console.error(`Error: ${text.slice(0, 500)}`);
  }
} catch (error: any) {
  console.error(`Error: ${error.message}`);
}
