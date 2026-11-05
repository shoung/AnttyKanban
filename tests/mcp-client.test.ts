import test from 'node:test';
import { runMcpCrudAcceptance } from './fixtures/mcp-client.ts';

test('real MCP SDK HTTP client performs isolated mind map, board and synthetic-calendar CRUD', async () => {
  await runMcpCrudAcceptance();
});
