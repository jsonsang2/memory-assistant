import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const WORKER_URL = `http://localhost:${process.env.MEMORY_ASSISTANT_PORT || 37888}`;
const AUTH_TOKEN_FILE = path.join(os.homedir(), '.memory-assistant', 'auth-token');

function getAuthToken(): string {
  try { return fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function authHeaders(): Record<string, string> {
  return { 'x-auth-token': getAuthToken() };
}

const server = new Server(
  { name: 'memory-assistant', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: 'Search persistent memory for observations, sessions, and tool use history. Returns compact index with IDs and snippets.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Full-text search query' },
          project: { type: 'string', description: 'Filter by project path' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
          offset: { type: 'number', description: 'Pagination offset' },
          date_gte: { type: 'string', description: 'Filter from date (ISO 8601)' },
          date_lte: { type: 'string', description: 'Filter to date (ISO 8601)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'timeline',
      description: 'Get context around a specific observation. Returns the anchor observation plus N observations before and after it.',
      inputSchema: {
        type: 'object',
        properties: {
          anchor_id: { type: 'number', description: 'Observation ID to use as anchor' },
          before: { type: 'number', description: 'Number of observations before anchor (default: 3)' },
          after: { type: 'number', description: 'Number of observations after anchor (default: 3)' },
        },
        required: ['anchor_id'],
      },
    },
    {
      name: 'get_observations',
      description: 'Fetch full details for specific observations by ID. Use after search/timeline to get complete data.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'Array of observation IDs to fetch',
          },
        },
        required: ['ids'],
      },
    },
    {
      name: 'semantic_search',
      description: 'Semantic vector search using ChromaDB. Better than keyword search for conceptual queries like "how did we fix authentication" or "database optimization". Requires ChromaDB running.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language query' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
        required: ['query'],
      },
    },
  ],
}));

// Tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    if (name === 'search') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args || {})) {
        if (v !== undefined) params.append(k, String(v));
      }
      const res = await fetch(`${WORKER_URL}/api/search?${params}`, { headers: authHeaders() });
      result = await res.json();
    } else if (name === 'timeline') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args || {})) {
        if (v !== undefined) params.append(k, String(v));
      }
      const res = await fetch(`${WORKER_URL}/api/timeline?${params}`, { headers: authHeaders() });
      result = await res.json();
    } else if (name === 'get_observations') {
      const res = await fetch(`${WORKER_URL}/api/observations/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(args),
      });
      result = await res.json();
    } else if (name === 'semantic_search') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args || {})) {
        if (v !== undefined) params.append(k, String(v));
      }
      const res = await fetch(`${WORKER_URL}/api/search/semantic?${params}`, { headers: authHeaders() });
      result = await res.json();
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
