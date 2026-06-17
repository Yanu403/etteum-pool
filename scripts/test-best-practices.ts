#!/usr/bin/env bun
/**
 * Test script untuk verify best practices implementation:
 * 1. Read tool dengan path dan line limit support
 * 2. Working directory tracking dengan cd detection
 * 3. MCP tools extraction
 */

import { ToolBridge, detectCwdCommand, resolveToolPaths } from '../src/proxy/providers/gitlab-duo/tools';
import { GitlabDuoProvider } from '../src/proxy/providers/gitlab-duo';

console.log('🧪 Testing GitLab Duo Best Practices Implementation\n');

// ============================================================================
// Test 1: Read Tool dengan Line Limit
// ============================================================================
console.log('📖 Test 1: Read Tool dengan Line Limit');
console.log('='.repeat(60));

const readAction = {
  requestID: 'test-1',
  runReadFile: {
    filepath: '/home/user/project/src/index.ts',
    lineOffset: 10,
    chunkSize: 50
  }
};

const readToolResult = ToolBridge.match(readAction, [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' }
        },
        required: ['path']
      }
    }
  }
]);

console.log('✅ Read action matched:', readToolResult?.name);
console.log('✅ Arguments:', readToolResult?.argsJson);

const readArgs = JSON.parse(readToolResult?.argsJson || '{}');
console.log('✅ Parsed args:', {
  path: readArgs.path,
  offset: readArgs.offset,
  limit: readArgs.limit
});

if (readArgs.path === '/home/user/project/src/index.ts' && 
    readArgs.offset === 10 && 
    readArgs.limit === 50) {
  console.log('✅ PASS: Read tool correctly forwards path, offset, and limit\n');
} else {
  console.log('❌ FAIL: Read tool arguments incorrect\n');
  process.exit(1);
}

// ============================================================================
// Test 2: Working Directory Tracking
// ============================================================================
console.log('📁 Test 2: Working Directory Tracking');
console.log('='.repeat(60));

// Test 2.1: Simple cd command
const cwd1 = detectCwdCommand('cd /home/user/project', '/home/user');
console.log('✅ cd /home/user/project →', cwd1);
if (cwd1 !== '/home/user/project') {
  console.log('❌ FAIL: Simple cd detection failed\n');
  process.exit(1);
}

// Test 2.2: Relative cd command
const cwd2 = detectCwdCommand('cd src/components', '/home/user/project');
console.log('✅ cd src/components →', cwd2);
if (cwd2 !== '/home/user/project/src/components') {
  console.log('❌ FAIL: Relative cd detection failed\n');
  process.exit(1);
}

// Test 2.3: cd with && chain
const cwd3 = detectCwdCommand('cd src && ls -la', '/home/user/project');
console.log('✅ cd src && ls -la →', cwd3);
if (cwd3 !== '/home/user/project/src') {
  console.log('❌ FAIL: cd with && chain detection failed\n');
  process.exit(1);
}

// Test 2.4: cd with quotes
const cwd4 = detectCwdCommand('cd "my folder/subdir"', '/home/user');
console.log('✅ cd "my folder/subdir" →', cwd4);
if (cwd4 !== '/home/user/my folder/subdir') {
  console.log('❌ FAIL: cd with quotes detection failed\n');
  process.exit(1);
}

// Test 2.5: No cd command
const cwd5 = detectCwdCommand('ls -la', '/home/user/project');
console.log('✅ ls -la →', cwd5 || '(no change)');
if (cwd5 !== null) {
  console.log('❌ FAIL: False positive cd detection\n');
  process.exit(1);
}

console.log('✅ PASS: Working directory tracking works correctly\n');

// ============================================================================
// Test 3: Path Resolution
// ============================================================================
console.log('🔗 Test 3: Path Resolution');
console.log('='.repeat(60));

const testArgs1 = JSON.stringify({
  filepath: 'src/index.ts',
  pattern: 'function'
});

const resolved1 = resolveToolPaths(testArgs1, 'Grep', '/home/user/project');
console.log('✅ Relative path resolved:', resolved1);

const resolvedArgs1 = JSON.parse(resolved1);
if (resolvedArgs1.filepath !== '/home/user/project/src/index.ts') {
  console.log('❌ FAIL: Path resolution failed\n');
  process.exit(1);
}

// Test with absolute path (should not change)
const testArgs2 = JSON.stringify({
  filepath: '/absolute/path/file.ts',
  pattern: 'class'
});

const resolved2 = resolveToolPaths(testArgs2, 'Grep', '/home/user/project');
console.log('✅ Absolute path unchanged:', resolved2);

const resolvedArgs2 = JSON.parse(resolved2);
if (resolvedArgs2.filepath !== '/absolute/path/file.ts') {
  console.log('❌ FAIL: Absolute path should not change\n');
  process.exit(1);
}

console.log('✅ PASS: Path resolution works correctly\n');

// ============================================================================
// Test 4: MCP Tools Extraction
// ============================================================================
console.log('🔧 Test 4: MCP Tools Extraction');
console.log('='.repeat(60));

const mockRequest = {
  model: 'claude_sonnet_4_6',
  messages: [{ role: 'user', content: 'Test' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'context7__resolve-library-id',
        description: 'Resolve library ID',
        parameters: {
          type: 'object',
          properties: {
            libraryName: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'playwright__browser_navigate',
        description: 'Navigate browser',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Execute shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' }
          }
        }
      }
    }
  ]
};

// Test MCP tools extraction using provider instance
const provider = new GitlabDuoProvider();
const mcpTools = (provider as any).extractMcpTools(mockRequest);
console.log('✅ Extracted MCP tools:', mcpTools.length);
console.log('✅ Tools:', JSON.stringify(mcpTools, null, 2));

if (mcpTools.length !== 2) {
  console.log('❌ FAIL: Expected 2 MCP tools, got', mcpTools.length);
  process.exit(1);
}

const context7Tool = mcpTools.find((t: any) => t.tool === 'resolve-library-id');
const playwrightTool = mcpTools.find((t: any) => t.tool === 'browser_navigate');

if (!context7Tool || !playwrightTool) {
  console.log('❌ FAIL: Missing expected MCP tools\n');
  process.exit(1);
}

if (context7Tool.server !== 'context7' || playwrightTool.server !== 'playwright') {
  console.log('❌ FAIL: MCP tool server names incorrect\n');
  process.exit(1);
}

console.log('✅ PASS: MCP tools extraction works correctly\n');

// ============================================================================
// Test 5: MCP Tool Call Matching
// ============================================================================
console.log('🎯 Test 5: MCP Tool Call Matching');
console.log('='.repeat(60));

const mcpAction = {
  requestID: 'test-mcp-1',
  runMCPCall: {
    server: 'context7',
    tool: 'resolve-library-id',
    arguments: {
      libraryName: 'react',
      version: '18.2.0'
    }
  }
};

const mcpMatch = ToolBridge.match(mcpAction, mockRequest.tools || []);
console.log('✅ MCP action matched:', mcpMatch?.name);
console.log('✅ Arguments:', mcpMatch?.argsJson);

if (mcpMatch?.name !== 'context7__resolve-library-id') {
  console.log('❌ FAIL: MCP tool name mismatch\n');
  process.exit(1);
}

const mcpArgs = JSON.parse(mcpMatch?.argsJson || '{}');
if (mcpArgs.libraryName !== 'react' || mcpArgs.version !== '18.2.0') {
  console.log('❌ FAIL: MCP arguments mismatch\n');
  process.exit(1);
}

console.log('✅ PASS: MCP tool call matching works correctly\n');

// ============================================================================
// Summary
// ============================================================================
console.log('='.repeat(60));
console.log('🎉 All tests passed! Best practices implementation verified.');
console.log('='.repeat(60));
console.log('\nSummary:');
console.log('✅ Read tool supports path and line limit');
console.log('✅ Working directory tracking with cd detection');
console.log('✅ Path resolution for relative paths');
console.log('✅ MCP tools extraction from client tools');
console.log('✅ MCP tool call matching and forwarding');
console.log('\nGitLab Duo provider now follows best practices for AI agents!');
