import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = process.env.PORT || 3000;

// IMPORTANT: Claude custom connectors often don't let you pass arbitrary headers.
// If MCP_API_KEY is unset, server runs "authless" (recommended to get working first).
const MCP_API_KEY = process.env.MCP_API_KEY?.trim() || null;

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
    timeout: 20000,
  });
}

// Optional API key middleware (authless if MCP_API_KEY not set)
function checkKey(req, res, next) {
  if (!MCP_API_KEY) return next();

  const headerKey = req.headers['x-mcp-api-key'];
  const auth = req.headers['authorization'];
  const bearer =
    typeof auth === 'string' && auth.startsWith('Bearer ')
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

async function safeGet(zd, url, params) {
  try {
    const r = await zd.get(url, { params });
    return r.data;
  } catch {
    return null;
  }
}

// Small concurrency limiter to reduce Zendesk rate-limit issues
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

// ---- MCP Server: tools + schema ----
function buildServer() {
  const server = new McpServer(
    { name: 'zendesk-readonly-mcp', version: '1.0.0' },
    { capabilities: { logging: {} } }
  );

  // Tool: ping
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

  // Tool: get single ticket (basic)
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
        channel: t.via?.channel || null,
        url: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${t.id}`,
        description: include_description ? t.description : undefined,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  // Tool: search Help Center
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

      const params = new URLSearchParams();
      params.set('query', query);
      if (locale) params.set('locale', locale);
      params.set('per_page', String(per_page));

      const { data } = await zd.get(
        `/api/v2/help_center/articles/search.json?${params.toString()}`
      );

      const results = (data.results || []).map((a) => ({
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

  /**
   * Tool: list_tickets
   * Returns tickets normalized to YOUR schema:
   * ticket_id, created_at, resolved_at, status, priority, channel, tags, subject,
   * user_message, agent_response, csat_score, agent_name, resolution_time_hrs
   *
   * Notes:
   * - resolved_at: uses solved_at if available; otherwise optionally audits.
   * - csat_score: satisfaction_rating endpoint (null if none).
   * - user_message / agent_response: derived from comments. To keep payload manageable,
   *   we concatenate comment bodies and truncate each side.
   */
  server.registerTool(
    'list_tickets',
    {
      description:
        'List Zendesk tickets from the last N days, normalized for CX analysis (read-only).',
      inputSchema: z.object({
        days: z.number().int().min(1).max(30).optional().default(7),
        per_page: z.number().int().min(1).max(100).optional().default(50),
        include_comments: z.boolean().optional().default(true),
        include_csat: z.boolean().optional().default(true),
        include_resolved_audits: z.boolean().optional().default(false),
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

      // Date cutoff for search
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const yyyy = since.getUTCFullYear();
      const mm = String(since.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(since.getUTCDate()).padStart(2, '0');
      const sinceStr = `${yyyy}-${mm}-${dd}`;

      // Pull tickets via Search API
      const query = `type:ticket created>${sinceStr}`;
      const { data: search } = await zd.get('/api/v2/search.json', {
        params: { query, per_page, sort_by: 'created_at', sort_order: 'desc' },
      });

      const rawTickets = search.results || [];

      // Batch fetch agent names
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
            const agent_name = t.assignee_id ? agentNameById[t.assignee_id] || null : null;

            // resolved_at: prefer solved_at / closed_at if present
            let resolved_at = t.solved_at || t.closed_at || null;

            // Optional fallback: audits to find status changed to solved/closed
            if (!resolved_at && include_resolved_audits) {
              const audits = await safeGet(zd, `/api/v2/tickets/${ticket_id}/audits.json`);
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
              const ms = new Date(resolved_at).getTime() - new Date(created_at).getTime();
              if (!Number.isNaN(ms) && ms >= 0) {
                resolution_time_hrs = Math.round((ms / 3600000) * 10) / 10; // 1 decimal
              }
            }

            // csat_score
            let csat_score = null;
            if (include_csat) {
              const csat = await safeGet(
                zd,
                `/api/v2/tickets/${ticket_id}/satisfaction_rating.json`
              );
              // Zendesk returns: { satisfaction_rating: { score: "good|bad", ... } } or 404
              csat_score = csat?.satisfaction_rating?.score || null;
            }

            // user_message / agent_response from comments
            let user_message = '';
            let agent_response = '';

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

                // requester comments vs others
                if (requester_id && c.author_id === requester_id) {
                  userParts.push(body);
                } else {
                  agentParts.push(body);
                }
              }

              user_message = userParts.join('\n\n---\n\n').slice(0, max_text_chars);
              agent_response = agentParts.join('\n\n---\n\n').slice(0, max_text_chars);
            }

            return {
              ticket_id,
              created_at,
              resolved_at,
              status,
              priority,
              channel,
              tags,
              subject,
              user_message: user_message || null,
              agent_response: agent_response || null,
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

// ---- HTTP host app ----
const app = express();
app.use(express.json({ limit: '2mb' }));

// Health endpoint
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// MCP endpoint (Streamable HTTP, JSON response enabled)
app.post('/mcp', checkKey, async (req, res) => {
  try {
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
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// For browsers / incorrect methods
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').send('Method Not Allowed'));
app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').send('Method Not Allowed'));

app.listen(PORT, () => {
  console.log(`Zendesk MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
});
