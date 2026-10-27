// Server MCP stdio di prova: lo strumento «variabile» dice il valore di una variabile d'ambiente
// (per controllare che un riferimento op:// arrivi al server già letto da 1Password).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'prova-env', version: '1' });
server.registerTool('variabile', {
  description: 'Valore di una variabile d\'ambiente del server.',
  inputSchema: { nome: z.string() },
  annotations: { readOnlyHint: true },
}, ({ nome }) => ({ content: [{ type: 'text', text: process.env[nome] ?? '(non impostata)' }] }));
await server.connect(new StdioServerTransport());
