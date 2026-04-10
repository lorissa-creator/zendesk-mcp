/**
 * Zendesk MCP — compact metadata + full conversation
 *
 * Access pattern:
 *   /mcp/:secret
 *
 * Tools:
 * - ping
 * - search_tickets_compact
 * - get_ticket_conversation
 */

import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = process.env.PORT || 3000;

// Path-based secret for shareable MCP URL
const MCP_ROUTE_SECRET = (process.env.MCP_ROUTE_SECRET || '').trim();

const ZENDESK_SUBDOMAIN = (process.env.ZENDESK_SUBDOMAIN || '').trim();
const ZENDESK_EMAIL = (process.env.ZENDESK_EMAIL || '').trim();
const ZENDESK_API_TOKEN = (process.env.ZENDESK_API_TOKEN || '').trim();

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
    const resp = await zd.get(url, params ? { params } : undefined);
    return resp.data;
  } catch (error) {
    console.error('Zendesk GET failed:', url, error?.response?.status, error?.message);
    return null;
  }
}

function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function truncate(text, maxChars = 2000) {
  if (text == null) return null;
  const s = String(text);
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…`;
}

function minutesToHours(mins) {
  if (mins == null) return null;
  const n = Number(mins);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 60) * 10) / 10;
}

async function fetchUsersByIds(zd, ids) {
  const unique = uniq(ids);
  if (!unique.length) return {};

  const chunks = chunkArray(unique, 100);
  const map = {};

  for (const chunk of chunks) {
    const data = await safeGet(zd, '/api/v2/users/show_many.json', { ids: chunk.join(',') });
    for (const u of data?.users || []) {
      map[u.id] = {
        id: u.id,
        name: u.name || null,
        email: u.email || null,
        role: u.role || null,
        tags: Array.isArray(u.tags) ? u.tags : [],
      };
    }
  }

  return map;
}

async function fetchGroupsByIds(zd, ids) {
  const unique = uniq(ids);
  if (!unique.length) return {};

  const chunks = chunkArray(unique, 100);
  const map = {};

  for (const chunk of chunks) {
    const data = await safeGet(zd, '/api/v2/groups/show_many.json', { ids: chunk.join(',') });
    for (const g of data?.groups || []) {
      map[g.id] = {
        id: g.id,
        name: g.name || null,
      };
    }
  }

  return map;
}

async function getTicketMetrics(zd, ticketId) {
  const m = await safeGet(zd, `/api/v2/tickets/${ticketId}/metrics.json`);
  const metric = m?.ticket_metric;
  if (!metric) return null;

  const firstReplyMin = metric.first_reply_time_in_minutes?.calendar ?? null;
  const fullResMin = metric.full_resolution_time_in_minutes?.calendar ?? null;

  return {
    first_reply_time_mins: firstReplyMin,
    first_reply_time_hrs: minutesToHours(firstReplyMin),
    resolution_time_mins: fullResMin,
    resolution_time_hrs: minutesToHours(fullResMin),
  };
}

async function getCsatScore(zd, ticketId) {
  const csat = await safeGet(zd, `/api/v2/tickets/${ticketId}/satisfaction_rating.json`);
  return csat?.satisfaction_rating?.score || null;
}

function normalizeCompactTicket(t, userMap = {}, groupMap = {}, extra = {}) {
  const requester = userMap[t.requester_id] || null;
  const assignee = userMap[t.assignee_id] || null;
  const submitter = userMap[t.submitter_id] || null;
  const group = groupMap[t.group_id] || null;

  return {
    ticket_id: t.id,
    subject: t.subject || '',
    status: t.status || null,
    priority: t.priority || null,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    solved_at: t.solved_at || null,
    closed_at: t.closed_at || null,
    channel: t?.via?.channel || null,
    tags: Array.isArray(t.tags) ? t.tags : [],
    requester_email: requester?.email || null,
    requester_name: requester?.name || null,
    requester_tags: requester?.tags || [],
    assignee_name: assignee?.name || null,
    assignee_email: assignee?.email || null,
    submitter_name: submitter?.name || null,
    group_id: t.group_id || null,
    group_name: group?.name || null,
    csat_score: extra.csat_score ?? null,
    first_reply_time_mins: extra.first_reply_time_mins ?? null,
    first_reply_time_hrs: extra.first_reply_time_hrs ?? null,
    resolution_time_mins: extra.resolution_time_mins ?? null,
    resolution_time_hrs: extra.resolution_time_hrs ?? null,
    public_message_count: extra.public_message_count ?? null,
    first_customer_message_snippet: extra.first_customer_message_snippet ?? null,
    last_public_reply_snippet: extra.last_public_reply_snippet ?? null,
  };
}

async function searchPage(zd, { query, per_page = 100, pageUrl = null }) {
  const url =
    pageUrl ||
    `/api/v2/search.json?${new URLSearchParams({
      query,
      per_page: String(per_page),
      sort_by: 'created_at',
      sort_order: 'desc',
    }).toString()}`;

  const resp = url.startsWith('http') ? await zd.get(url, { baseURL: '' }) : await zd.get(url);
  const data = resp.data || {};

  return {
    results: data.results || [],
    next_page: data.next_page || null,
    count: data.count ?? null,
  };
}

async function getConversationSummaryBits(zd, ticketId) {
  const commentsWrap = await safeGet(zd, `/api/v2/tickets/${ticketId}/comments.json`);
  const comments = commentsWrap?.comments || [];

  const publicComments = comments.filter((c) => c.public);
  const firstPublic = publicComments[0] || null;
  const lastPublic = publicComments[publicComments.length - 1] || null;

  return {
    public_message_count: publicComments.length,
    first_customer_message_snippet: truncate(firstPublic?.plain_body || firstPublic?.body || '', 500),
    last_public_reply_snippet: truncate(lastPublic?.plain_body || lastPublic?.body || '', 500),
  };
}

async function getTicketConversation(zd, ticketId, maxTextCharsPerMessage = 12000) {
  const ticketWrap = await safeGet(zd, `/api/v2/tickets/${ticketId}.json`);
  const ticket = ticketWrap?.ticket;
  if (!ticket) return null;

  const commentsWrap = await safeGet(zd, `/api/v2/tickets/${ticketId}/comments.json`);
  const comments = commentsWrap?.comments || [];

  const allUserIds = uniq([
    ticket.requester_id,
    ticket.assignee_id,
    ticket.submitter_id,
    ...comments.map((c) => c.author_id),
  ]);

  const userMap = await fetchUsersByIds(zd, allUserIds);
  const groupMap = await fetchGroupsByIds(zd, [ticket.group_id].filter(Boolean));
  const metrics = await getTicketMetrics(zd, ticketId);
  const csat = await getCsatScore(zd, ticketId);

  const ticketInfo = normalizeCompactTicket(ticket, userMap, groupMap, {
    csat_score: csat,
    first_reply_time_mins: metrics?.first_reply_time_mins ?? null,
    first_reply_time_hrs: metrics?.first_reply_time_hrs ?? null,
    resolution_time_mins: metrics?.resolution_time_mins ?? null,
    resolution_time_hrs: metrics?.resolution_time_hrs ?? null,
  });

  const messages = comments.map((c) => {
    const author = userMap[c.author_id] || null;
    return {
      comment_id: c.id || null,
      created_at: c.created_at || null,
      public: !!c.public,
      author_id: c.author_id || null,
      author_name: author?.name || null,
      author_email: author?.email || null,
      author_role: author?.role || null,
      body: truncate((c.plain_body || c.body || '').trim(), maxTextCharsPerMessage),
    };
  });

  const conversation_text = truncate(
    messages
      .map((m) => {
        const visibility = m.public ? 'public' : 'private';
        const who = m.author_name || m.author_email || 'unknown';
        return `[${m.created_at}] [${visibility}] ${who}: ${m.body || ''}`;
      })
      .join('\n\n'),
    50000
  );

  return {
    ticket: ticketInfo,
    messages,
    conversation_text,
  };
}

function createMcpServer() {
  const server = new McpServer(
    { name: 'zendesk-mcp', version: '1.0.0' },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    'ping',
    {
      description: 'Health check tool',
      inputSchema: z.object({}).passthrough(),
    },
    async () => ({
      content: [{ type: 'text', text: 'pong' }],
      structuredContent: { ok: true },
    })
  );

  server.registerTool(
    'search_tickets_compact',
    {
      description:
        'Search Zendesk tickets and return compact metadata for bulk analysis. Best for tags, requester email, date range, status, and segmentation.',
      inputSchema: z.object({
        query: z.string().min(1),
        per_page: z.number().int().min(1).max(100).optional().default(50),
        next_page: z.string().optional().nullable(),
        max_return: z.number().int().min(1).max(200).optional().default(50),
        include_metrics: z.boolean().optional().default(false),
        include_csat: z.boolean().optional().default(false),
        include_message_snippets: z.boolean().optional().default(false),
      }),
    },
    async ({ query, per_page, next_page, max_return, include_metrics, include_csat, include_message_snippets }) => {
      const zd = zendeskClient();
      const page = await searchPage(zd, { query, per_page, pageUrl: next_page || null });
      const sliced = (page.results || []).slice(0, max_return);

      const userMap = await fetchUsersByIds(
        zd,
        sliced.flatMap((t) => [t.requester_id, t.assignee_id, t.submitter_id]).filter(Boolean)
      );
      const groupMap = await fetchGroupsByIds(zd, sliced.map((t) => t.group_id).filter(Boolean));

      const tickets = [];
      for (const t of sliced) {
        let metrics = null;
        let csat = null;
        let summaryBits = null;

        if (include_metrics) metrics = await getTicketMetrics(zd, t.id);
        if (include_csat) csat = await getCsatScore(zd, t.id);
        if (include_message_snippets) summaryBits = await getConversationSummaryBits(zd, t.id);

        tickets.push(
          normalizeCompactTicket(t, userMap, groupMap, {
            csat_score: csat,
            first_reply_time_mins: metrics?.first_reply_time_mins ?? null,
            first_reply_time_hrs: metrics?.first_reply_time_hrs ?? null,
            resolution_time_mins: metrics?.resolution_time_mins ?? null,
            resolution_time_hrs: metrics?.resolution_time_hrs ?? null,
            public_message_count: summaryBits?.public_message_count ?? null,
            first_customer_message_snippet: summaryBits?.first_customer_message_snippet ?? null,
            last_public_reply_snippet: summaryBits?.last_public_reply_snippet ?? null,
          })
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tickets,
                next_page: page.next_page,
                count: page.count,
              },
              null,
              2
            ),
          },
        ],
        structuredContent: {
          tickets,
          next_page: page.next_page,
          count: page.count,
        },
      };
    }
  );

  server.registerTool(
    'get_ticket_conversation',
    {
      description:
        'Get the full ticket conversation with ordered messages, authors, public/private flags, and combined conversation text for qualitative analysis.',
      inputSchema: z.object({
        ticket_id: z.number().int(),
        max_text_chars_per_message: z.number().int().min(500).max(30000).optional().default(12000),
      }),
    },
    async ({ ticket_id, max_text_chars_per_message }) => {
      const zd = zendeskClient();
      const result = await getTicketConversation(zd, ticket_id, max_text_chars_per_message);

      if (!result) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found' }) }],
          structuredContent: { error: 'Ticket not found' },
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  return server;
}

// Global transport/server
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  enableJsonResponse: true,
});

const server = createMcpServer();
await server.connect(transport);

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'zendesk-mcp',
  });
});

// Secret is part of the path
app.all('/mcp/:secret', async (req, res) => {
  try {
    if (!MCP_ROUTE_SECRET) {
      return res.status(500).json({
        jsonrpc: '2.0',
        error: { code: 500, message: 'Server secret not configured' },
        id: null,
      });
    }

    const provided = (req.params.secret || '').toString();
    if (provided !== MCP_ROUTE_SECRET) {
      return res.status(401).end();
    }

    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Zendesk MCP server listening on port ${PORT}`);
  console.log(`Health endpoint: /health`);
  console.log(`Protected MCP endpoint: /mcp/:secret`);
});
