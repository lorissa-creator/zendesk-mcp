import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = process.env.PORT || 3000;

// ✅ Shared secret gate (Claude-friendly): /mcp?secret=...
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET?.trim() || '';

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
    timeout: 30000,
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

function truncate(s, maxChars) {
  if (!s) return null;
  const t = String(s);
  return t.length <= maxChars ? t : t.slice(0, maxChars) + '…';
}

function computeResolutionHours(created_at, resolved_at) {
  if (!created_at || !resolved_at) return null;
  const ms = new Date(resolved_at).getTime() - new Date(created_at).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.round((ms / 3600000) * 10) / 10;
}

async function resolveResolvedAt({
  zd,
  ticket_id,
  created_at,
  solved_at,
  closed_at,
  include_resolved_audits,
}) {
  let resolved_at = solved_at || closed_at || null;

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

  return {
    resolved_at,
    resolution_time_hrs: computeResolutionHours(created_at, resolved_at),
  };
}

async function buildMessagesFromComments({
  zd,
  ticket_id,
  requester_id,
  max_text_chars,
  include_author_map,
}) {
  const comments = await safeGet(zd, `/api/v2/tickets/${ticket_id}/comments.json`);
  const commentList = comments?.comments || [];

  let authorNameById = {};
  if (include_author_map) {
    const authorIds = Array.from(new Set(commentList.map((c) => c.author_id).filter(Boolean)));
    if (authorIds.length) {
      const users = await safeGet(zd, '/api/v2/users/show_many.json', {
        ids: authorIds.join(','),
      });
      for (const u of users?.users || []) authorNameById[u.id] = u.name;
    }
  }

  const userParts = [];
  const agentParts = [];
  const thread = [];

  for (const c of commentList) {
    const body = (c.body || '').trim();
    if (!body) continue;

    const isUser = requester_id && c.author_id === requester_id;

    if (isUser) userParts.push(body);
    else agentParts.push(body);

    thread.push({
      author_id: c.author_id,
      author_name: include_author_map ? authorNameById[c.author_id] || null : null,
      is_customer: Boolean(isUser),
      created_at: c.created_at || null,
      body: truncate(body, max_text_chars),
      public: c.public ?? true,
    });
  }

  return {
    user_message: truncate(userParts.join('\n\n---\n\n'), max_text_chars),
    agent_response: truncate(agentParts.join('\n\n---\n\n'), max_text_chars),
    thread,
  };
}

// Helper: paginate Zendesk Search API (for requester email)
async function fetchAllSearch(zd, firstUrl, maxTickets = 500, pageLimit = 200) {
  let nextUrl = firstUrl;
  let pages = 0;
  const results = [];

  while (nextUrl && results.length < maxTickets && pages < pageLimit) {
    pages++;

    const resp = nextUrl.startsWith('http')
      ? await zd.get(nextUrl, { baseURL: '' })
      : await zd.get(nextUrl);

    const data = resp.data;
    results.push(...(data.results || []));
    nextUrl = data.next_page || null;
  }

  return results.slice(0, maxTickets);
}

// ---- MCP server factory (NEW SERVER PER SESSION) ----
function createMcpServer() {
  const server = new McpServer(
    { name: 'zendesk-readonly-mcp', version: '2.1.0' },
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

  /**
   * ✅ list_tickets (Incremental Export)
   * Default: start_date = 2026-01-01
   */
  server.registerTool(
    'list_tickets',
    {
      description:
        'List Zendesk tickets using Incremental Export (best for large date ranges), normalized for CX analysis.',
      inputSchema: z.object({
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .default('2026-01-01'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        max_tickets: z.number().int().min(1).max(200000).optional().default(20000),

        include_comments: z.boolean().optional().default(false),
        include_csat: z.boolean().optional().default(false),
        include_resolved_audits: z.boolean().optional().default(false),

        max_text_chars: z.number().int().min(200).max(5000).optional().default(2000),
      }),
    },
    async ({
      start_date,
      end_date,
      max_tickets,
      include_comments,
      include_csat,
      include_resolved_audits,
      max_text_chars,
    }) => {
      const zd = zendeskClient();
      const runLimited = limiter(6);

      const startUnix = Math.floor(new Date(`${start_date}T00:00:00Z`).getTime() / 1000);
      if (!Number.isFinite(startUnix) || startUnix <= 0) {
        throw new Error('Invalid start_date. Use YYYY-MM-DD.');
      }

      const endMs = end_date ? new Date(`${end_date}T23:59:59Z`).getTime() : null;

      let nextUrl = `/api/v2/incremental/tickets.json?start_time=${startUnix}`;
      const collected = [];

      while (nextUrl && collected.length < max_tickets) {
        const resp = nextUrl.startsWith('http')
          ? await zd.get(nextUrl, { baseURL: '' })
          : await zd.get(nextUrl);

        const data = resp.data;
        const batch = data.tickets || [];

        for (const t of batch) {
          if (endMs) {
            const createdMs = new Date(t.created_at).getTime();
            if (!Number.isNaN(createdMs) && createdMs > endMs) {
              nextUrl = null;
              break;
            }
          }
          collected.push(t);
          if (collected.length >= max_tickets) break;
        }

        if (!nextUrl) break;
        if (data.end_of_stream) break;
        nextUrl = data.next_page || null;
      }

      // Batch fetch agent names
      const assigneeIds = Array.from(new Set(collected.map((t) => t.assignee_id).filter(Boolean)));
      const agentNameById = {};
      if (assigneeIds.length) {
        const users = await safeGet(zd, '/api/v2/users/show_many.json', {
          ids: assigneeIds.join(','),
        });
        for (const u of users?.users || []) agentNameById[u.id] = u.name;
      }

      const tickets = await Promise.all(
        collected.map((t) =>
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

            const { resolved_at, resolution_time_hrs } = await resolveResolvedAt({
              zd,
              ticket_id,
              created_at,
              solved_at: t.solved_at,
              closed_at: t.closed_at,
              include_resolved_audits,
            });

            let csat_score = null;
            if (include_csat) {
              const csat = await safeGet(
                zd,
                `/api/v2/tickets/${ticket_id}/satisfaction_rating.json`
              );
              csat_score = csat?.satisfaction_rating?.score || null;
            }

            let user_message = null;
            let agent_response = null;
            if (include_comments) {
              const msg = await buildMessagesFromComments({
                zd,
                ticket_id,
                requester_id,
                max_text_chars,
                include_author_map: false,
              });
              user_message = msg.user_message;
              agent_response = msg.agent_response;
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

  /**
   * ✅ search_tickets_by_requester_email (fast lookup via Search API)
   */
  server.registerTool(
    'search_tickets_by_requester_email',
    {
      description:
        'Search tickets for a requester email (fast). Returns normalized schema (optional comments/csat).',
      inputSchema: z.object({
        email: z.string().email(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().default('2026-01-01'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        per_page: z.number().int().min(1).max(100).optional().default(100),
        max_tickets: z.number().int().min(1).max(5000).optional().default(500),

        include_comments: z.boolean().optional().default(false),
        include_csat: z.boolean().optional().default(false),
        include_resolved_audits: z.boolean().optional().default(false),
        max_text_chars: z.number().int().min(200).max(5000).optional().default(2000),
      }),
    },
    async ({
      email,
      start_date,
      end_date,
      per_page,
      max_tickets,
      include_comments,
      include_csat,
      include_resolved_audits,
      max_text_chars,
    }) => {
      const zd = zendeskClient();
      const runLimited = limiter(6);

      // 1) Find user by email
      const userSearch = await safeGet(zd, '/api/v2/users/search.json', {
        query: `email:${email}`,
      });
      const user = (userSearch?.users || [])[0];
      if (!user?.id) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { requester: { email }, tickets: [], note: 'No requester found for email.' },
                null,
                2
              ),
            },
          ],
          structuredContent: {
            requester: { email },
            tickets: [],
            note: 'No requester found for email.',
          },
        };
      }

      const requesterId = user.id;

      // 2) Search tickets by requester_id (paginate)
      let query = `type:ticket requester_id:${requesterId}`;
      if (start_date) query += ` created>=${start_date}`;
      if (end_date) query += ` created<=${end_date}`;

      const firstUrl = `/api/v2/search.json?${new URLSearchParams({
        query,
        per_page: String(per_page),
        sort_by: 'created_at',
        sort_order: 'desc',
      }).toString()}`;

      const rawTickets = await fetchAllSearch(zd, firstUrl, max_tickets, 200);

      // Batch fetch agent names
      const assigneeIds = Array.from(new Set(rawTickets.map((t) => t.assignee_id).filter(Boolean)));
      const agentNameById = {};
      if (assigneeIds.length) {
        const usersMany = await safeGet(zd, '/api/v2/users/show_many.json', {
          ids: assigneeIds.join(','),
        });
        for (const u of usersMany?.users || []) agentNameById[u.id] = u.name;
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

            const agent_name = t.assignee_id ? agentNameById[t.assignee_id] || null : null;

            const { resolved_at, resolution_time_hrs } = await resolveResolvedAt({
              zd,
              ticket_id,
              created_at,
              solved_at: t.solved_at,
              closed_at: t.closed_at,
              include_resolved_audits,
            });

            let csat_score = null;
            if (include_csat) {
              const csat = await safeGet(
                zd,
                `/api/v2/tickets/${ticket_id}/satisfaction_rating.json`
              );
              csat_score = csat?.satisfaction_rating?.score || null;
            }

            let user_message = null;
            let agent_response = null;
            if (include_comments) {
              const msg = await buildMessagesFromComments({
                zd,
                ticket_id,
                requester_id: requesterId,
                max_text_chars,
                include_author_map: false,
              });
              user_message = msg.user_message;
              agent_response = msg.agent_response;
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
        content: [{ type: 'text', text: JSON.stringify({ requester: { id: requesterId, email }, tickets }, null, 2) }],
        structuredContent: { requester: { id: requesterId, email }, tickets },
      };
    }
  );

  /**
   * ✅ get_ticket(ticket_id) — deep dive: full thread + CSAT
   */
  server.registerTool(
    'get_ticket',
    {
      description:
        'Get one Zendesk ticket with full conversation thread + CSAT; includes normalized fields.',
      inputSchema: z.object({
        ticket_id: z.number().int(),
        include_csat: z.boolean().optional().default(true),
        include_resolved_audits: z.boolean().optional().default(false),
        max_text_chars: z.number().int().min(200).max(10000).optional().default(5000),
      }),
    },
    async ({ ticket_id, include_csat, include_resolved_audits, max_text_chars }) => {
      const zd = zendeskClient();

      const tWrap = await safeGet(zd, `/api/v2/tickets/${ticket_id}.json`);
      if (!tWrap?.ticket) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found' }, null, 2) }],
          structuredContent: { error: 'Ticket not found' },
        };
      }

      const t = tWrap.ticket;

      let agent_name = null;
      if (t.assignee_id) {
        const u = await safeGet(zd, `/api/v2/users/${t.assignee_id}.json`);
        agent_name = u?.user?.name || null;
      }

      const { resolved_at, resolution_time_hrs } = await resolveResolvedAt({
        zd,
        ticket_id,
        created_at: t.created_at,
        solved_at: t.solved_at,
        closed_at: t.closed_at,
        include_resolved_audits,
      });

      let csat_score = null;
      let csat_detail = null;
      if (include_csat) {
        const csat = await safeGet(zd, `/api/v2/tickets/${ticket_id}/satisfaction_rating.json`);
        csat_score = csat?.satisfaction_rating?.score || null;
        csat_detail = csat?.satisfaction_rating || null;
      }

      const msg = await buildMessagesFromComments({
        zd,
        ticket_id,
        requester_id: t.requester_id || null,
        max_text_chars,
        include_author_map: true,
      });

      const normalized = {
        ticket_id: t.id,
        created_at: t.created_at,
        resolved_at,
        status: t.status,
        priority: t.priority || 'normal',
        channel: t.via?.channel || null,
        tags: t.tags || [],
        subject: t.subject || '',
        user_message: msg.user_message,
        agent_response: msg.agent_response,
        csat_score,
        agent_name,
        resolution_time_hrs,
      };

      const output = {
        normalized,
        thread: msg.thread,
        csat_detail,
        zendesk: {
          url: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${t.id}`,
          assignee_id: t.assignee_id || null,
          requester_id: t.requester_id || null,
          group_id: t.group_id || null,
          brand_id: t.brand_id || null,
          updated_at: t.updated_at || null,
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  return server;
}

// ---- Sessions: sessionId -> { server, transport, lastSeen } ----
const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, s] of sessions.entries()) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      try { s.transport.close(); } catch {}
      try { s.server.close(); } catch {}
      sessions.delete(sessionId);
    }
  }
}
setInterval(cleanupSessions, 60 * 1000).unref();

async function getOrCreateSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    enableJsonResponse: true,
  });

  const server = createMcpServer();
  await server.connect(transport);

  const session = { server, transport, lastSeen: Date.now() };
  sessions.set(sessionId, session);
  return session;
}

// ---- HTTP app ----
const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/mcp', async (req, res) => {
  try {
    // ✅ Shared secret gate (URL param): /mcp?secret=...
    if (MCP_SHARED_SECRET) {
      const provided = (req.query?.secret || '').toString();
      if (provided !== MCP_SHARED_SECRET) {
        return res.status(401).json({
          jsonrpc: '2.0',
          error: { code: 401, message: 'Unauthorized' },
          id: null,
        });
      }
    }

    const sessionId =
      req.headers['mcp-session-id']?.toString() ||
      req.headers['x-mcp-session-id']?.toString() ||
      randomUUID();

    const session = await getOrCreateSession(sessionId);
    await session.transport.handleRequest(req, res, req.body);
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
  console.log(`Shared secret gate: ${MCP_SHARED_SECRET ? 'ENABLED' : 'DISABLED'}`);
});
