import assert from 'node:assert/strict';
import test from 'node:test';
import { runEvaluationSuite } from './evaluation-fixtures.js';
import { createMcpServer } from './mcp.js';
import { bearerTokenMatches } from '../utils/bearerAuth.js';

test('evaluation suite distinguishes passing and failing fixtures', () => {
  const result = runEvaluationSuite();
  assert.equal(result.total, 4);
  assert.equal(result.passed, 3);
  assert.equal(result.passRate, 0.75);
});

test('Bearer authentication rejects missing and incorrect tokens', () => {
  assert.equal(bearerTokenMatches(undefined, 'secret'), false);
  assert.equal(bearerTokenMatches('Bearer wrong!', 'secret'), false);
  assert.equal(bearerTokenMatches('Bearer secret', 'secret'), true);
});

test('MCP supports initialize, tool listing, and tool execution', async () => {
  const handle = createMcpServer([{
    name: 'sum',
    description: 'Adds two numbers',
    inputSchema: { type: 'object' },
    execute: async (args) => Number(args.left) + Number(args.right),
  }]);

  const initialized = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, 'saint-jude-ai');

  const listed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal((listed.result as { tools: unknown[] }).tools.length, 1);

  const called = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sum', arguments: { left: 2, right: 3 } } });
  assert.match((called.result as { content: Array<{ text: string }> }).content[0].text, /5/);
});