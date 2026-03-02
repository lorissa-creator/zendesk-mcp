import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = process.env.PORT || 3000;

// Zendesk env vars
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN?.trim() || '';
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL?.trim() || '';
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN?.trim() || '';

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

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
    timeout: 25000,
  });
}

async function safeGet(zd, url, params) {
  try {
    const r = await zd.get(url, { params });
    return r.data;
  } catch {
    return null;
  }
}

// Concurrency limiter (helps avoid Zendesk rate limits)
function limiter(max = 6) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active >= max) await new Promise((res) => queue.push(res));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

// ---- MCP server (global, stable) ----
function createMcpServer() {
  const server = new McpServer(
    { name: 'zendesk-readonly-mcp', version: '1.0.0' },
    { capabilities: { logging: {} } }
  );

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

  // The ONE tool your CX spec needs (normalized schema)
  server.registerTool(
    'list_tickets',
    {
      description:
        'List Zendesk tickets from the last N days, normalized for CX analysis.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(30).optional().default(7),
        per_page: z.number().int().min(1).max(100).optional().default(50),

        // For performance: set false if you only need metadata
        include_comments: z.boolean().optional().default(true),
        include_csat: z.boolean().optional().default(true),

        // Only turn this on if your account doesn’t provide solved_at/closed_at in search results
        include_resolved_audits: z.boolean().optional().default(false),

        // Prevent huge payloads
        max_text_chars: z.number().int().min(200).max(5000).optional().default(2000),
      }),
    },
    async ({
      days,
      per_page,
      include_comments,
      include_csat,
      include_resolved_audits,
      max_text_chars,
    }) => {
      const zd = zendeskClient();
      const runLimited = limiter(6);

      // Date cutoff for Zendesk Search API
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const yyyy = since.getUTCFullYear();
      const mm = String(since.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(since.getUTCDate()).padStart(2, '0');
      const sinceStr = `${yyyy}-${mm}-${dd}`;

      const query = `type:ticket created>${sinceStr}`;
      const { data: search } = await zd.get('/api/v2/search.json', {
        params: { query, per_page, sort_by: 'created_at', sort_order: 'desc' },
      });

      const rawTickets = search.results || [];

      // Batch fetch assignee names
      const assigneeIds = Array.from(
        new Set(rawTickets.map((t) => t.assignee_id).filter(Boolean))
      );

      const agentNameById = {};
      if (assigneeIds.length) {
        const users = await safeGet(zd, '/api/v2/users/show_many.json', {
          ids: assigneeIds.join(','),
        });
        for (const u of users?.users || []) agentNameById[u.id] = u.name;
      }

      const tickets = await Promise.all(
        rawTickets.map((t) =>
          runLimited(async () => {
            const ticket_id = t.id;
            const created_at = t.created_at;
            const status = t.status;
            const priority = t.priority || 'normal';
            const channel = t.via?.channel || null;
            const tags = t.tags || [];
            const subject = t.subject || '';
            const requester_id = t.requester_id || null;

            const agent_name = t.assignee_id
              ? agentNameById[t.assignee_id] || null
              : null;

            // resolved_at
            let resolved_at = t.solved_at || t.closed_at || null;

            // Optional audits fallback
            if (!resolved_at && include_resolved_audits) {
              const audits = await safeGet(
                zd,
                `/api/v2/tickets/${ticket_id}/audits.json`
              );
              if (audits?.audits?.length) {
                for (const a of audits.audits) {
                  const events = a.events || [];
                  const statusChange = events.find(
                    (e) =>
                      e.field_name === 'status' &&
                      (e.value === 'solved' || e.value === 'closed')
                  );
                  if (statusChange) {
                    resolved_at = a.created_at;
                    break;
                  }
                }
              }
            }

            // resolution_time_hrs
            let resolution_time_hrs = null;
            if (resolved_at && created_at) {
              const ms =
                new Date(resolved_at).getTime() - new Date(created_at).getTime();
              if (!Number.isNaN(ms) && ms >= 0) {
                resolution_time_hrs = Math.round((ms / 3600000) * 10) / 10;
              }
            }

            // csat_score
            let csat_score = null;
            if (include_csat) {
              const csat = await safeGet(
                zd,
                `/api/v2/tickets/${ticket_id}/satisfaction_rating.json`
              );
              csat_score = csat?.satisfaction_rating?.score || null; // "good" | "bad" | null
            }

            // user_message / agent_response
            let user_message = null;
            let agent_response = null;

            if (include_comments) {
              const comments = await safeGet(
                zd,
                `/api/v2/tickets/${ticket_id}/comments.json`
              );

              const userParts = [];
              const agentParts = [];

              for (const c of comments?.comments || []) {
                const body = (c.body || '').trim();
                if (!body) continue;

                if (requester_id && c.author_id === requester_id) {
                  userParts.push(body);
                } else {
                  agentParts.push(body);
                }
              }

              user_message = userParts.join('\n\n---\n\n').slice(0, max_text_chars) || null;
              agent_response = agentParts.join('\n\n---\n\n').slice(0, max_text_chars) || null;
            }

            // Return EXACT schema fields required by your skill spec
            return {
              ticket_id,
              created_at,
              resolved_at,
              status,
              priority,
              channel,
              tags,
              subject,
              user_message,
              agent_response,
              csat_score,
              agent_name,
              resolution_time_hrs,
            };
          })
        )
      );

      return {
        content: [{ type: 'text', text: JSON.stringify({ tickets }, null, 2) }],
        structuredContent: { tickets },
      };
    }
  );

  return server;
}

// Global server instance (stable)
const mcpServer = createMcpServer();

// Session-aware transports (so Claude can do proper handshake + tool discovery)
const transportsBySession = new Map();

function getOrCreateTransport(sessionId) {
  let transport = transportsBySession.get(sessionId);
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
    });
    transportsBySession.set(sessionId, transport);
    // Connect server once per new transport
    mcpServer.connect(transport).catch((e) => {
      console.error('MCP connect error:', e);
      transportsBySession.delete(sessionId);
    });
  }
  return transport;
}

// ---- HTTP app ----
const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// MCP endpoint
app.post('/mcp', async (req, res) => {
  try {
    // Use session header if present; otherwise generate a stable id for this request
    const sessionId =
      req.headers['mcp-session-id']?.toString() ||
      req.headers['x-mcp-session-id']?.toString() ||
      randomUUID();

    const transport = getOrCreateTransport(sessionId);
    await transport.handleRequest(req, res, req.body);

    // Cleanup when client closes (optional; you can keep sessions longer)
    res.on('close', () => {
      // Keep it simple: don’t delete immediately; avoids flakiness on reconnects.
      // If you want TTL cleanup later, we can add it.
    });
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', (req, res) =>
  res.status(405).set('Allow', 'POST').send('Method Not Allowed')
);

app.listen(PORT, () => {
  console.log(`Zendesk MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
});
