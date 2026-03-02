import 'dotenv/config';
import axios from 'axios';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const PORT = process.env.PORT || 3000;

// Optional “shared secret” check.
// IMPORTANT: Claude’s Custom Connector UI does NOT always support arbitrary API-key entry.
// So this is optional: if MCP_API_KEY is NOT set, server is authless.
const MCP_API_KEY = process.env.MCP_API_KEY?.trim();

// Zendesk env
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN?.trim();
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL?.trim();
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN?.trim();

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

// Only require Zendesk env if you actually call Zendesk tools
function zendeskClient() {
  requireEnv('ZENDESK_SUBDOMAIN', ZENDESK_SUBDOMAIN);
  requireEnv('ZENDESK_EMAIL', ZENDESK_EMAIL);
  requireEnv('ZENDESK_API_TOKEN', ZENDESK_API_TOKEN);

  return axios.create({
    baseURL: `https://${ZENDESK_SUBDOMAIN}.zendesk.com`,
    auth: {
      username: `${ZENDESK_EMAIL}/token`,
      password: ZENDESK_API_TOKEN,
    },
    timeout: 20000,
  });
}

// Minimal auth middleware (optional)
function checkKey(req, res, next) {
  if (!MCP_API_KEY) return next(); // authless mode

  const headerKey = req.headers['x-mcp-api-key'];
  const auth = req.headers['authorization'];
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : null;

  const provided = headerKey || bearer;

  if (provided !== MCP_API_KEY) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
  }
  next();
}

// Build MCP server + tools
function buildServer() {
  const server = new McpServer(
    { name: 'zendesk-readonly-mcp', version: '1.0.0' },
    { capabilities: { logging: {} } }
  );

  // Health / sanity tool (no Zendesk)
  server.registerTool(
    'ping',
    {
      description: 'Health check tool (no Zendesk)',
      inputSchema: z.object({}).passthrough(),
    },
    async () => ({
      content: [{ type: 'text', text: 'pong' }],
      structuredContent: { ok: true },
    })
  );

  // Read-only: get a ticket by ID (minimize PII)
  server.registerTool(
    'zendesk_get_ticket',
    {
      description: 'Get a Zendesk ticket summary by ticket ID (read-only)',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Zendesk ticket ID'),
        include_description: z.boolean().optional().default(false),
      }),
    },
    async ({ ticket_id, include_description }) => {
      const zd = zendeskClient();
      const { data } = await zd.get(`/api/v2/tickets/${ticket_id}.json`);
      const t = data.ticket;

      const out = {
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        created_at: t.created_at,
        updated_at: t.updated_at,
        tags: t.tags,
        url: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${t.id}`,
        description: include_description ? t.description : undefined,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  // Read-only: search Help Center articles (if HC is enabled)
  server.registerTool(
    'zendesk_search_help_center',
    {
      description: 'Search Zendesk Help Center articles (read-only)',
      inputSchema: z.object({
        query: z.string().min(2).describe('Search query'),
        locale: z.string().optional().describe('Locale, e.g. en-us'),
        per_page: z.number().int().min(1).max(25).optional().default(10),
      }),
    },
    async ({ query, locale, per_page }) => {
      const zd = zendeskClient();

      // HC search endpoint
      const params = new URLSearchParams();
      params.set('query', query);
      if (locale) params.set('locale', locale);
      params.set('per_page', String(per_page));

      const { data } = await zd.get(`/api/v2/help_center/articles/search.json?${params.toString()}`);

      const results = (data.results || []).map(a => ({
        id: a.id,
        title: a.title,
        locale: a.locale,
        url: a.html_url,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }],
        structuredContent: { results },
      };
    }
  );

  return server;
}

const app = createMcpExpressApp({ host: '0.0.0.0' });

// Optional health endpoint (nice for Render checks)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Stateless Streamable HTTP MCP endpoint
app.post('/mcp', checkKey, async (req, res) => {
  try {
    // Use JSON response mode (simpler for hosted servers)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });

    const server = buildServer();
    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);

    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error('MCP error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Spec says GET is used for SSE streams; since we’re JSON-response-only, return 405.
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').send('Method Not Allowed'));
app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').send('Method Not Allowed'));

app.listen(PORT, () => {
  console.log(`Zendesk MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
});
