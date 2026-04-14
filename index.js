/**
 * index.js — Zendesk MCP
 *
 * Purpose:
 * - Search tickets by requester email, tag, status, channel, date range, or free text
 * - Return audit-ready ticket payloads for QA/compliance review
 * - Include public conversation and internal comments
 * - Count public replies, requester messages, and internal notes
 * - Support safer bulk hydration in controlled batches
 *
 * Bot rules:
 * - requester = comment author matches ticket.requester_id
 * - bot names = Jené, Luna, Rachel Mint, Rachel
 * - everyone else = agent
 */

import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = process.env.PORT || 3000;

const MCP_SHARED_SECRET = (process.env.MCP_SHARED_SECRET || '').trim();

const ZENDESK_SUBDOMAIN = (process.env.ZENDESK_SUBDOMAIN || '').trim();
const ZENDESK_EMAIL = (process.env.ZENDESK_EMAIL || '').trim();
const ZENDESK_API_TOKEN = (process.env.ZENDESK_API_TOKEN || '').trim();

// Optional, but defaulted to your known bot names
const KNOWN_BOT_NAMES = (process.env.KNOWN_BOT_NAMES || 'Jené,Luna,Rachel Mint,Rachel')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

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
    const r = await zd.get(url, params ? { params } : undefined);
    return r.data;
  } catch {
    return null;
  }
}

function truncate(s, maxChars = 1500) {
  if (s == null) return null;
  const t = String(s);
  return t.length <= maxChars ? t : `${t.slice(0, maxChars)}…`;
}

function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchUsersByIds(zd, ids) {
  const unique = uniq(ids);
  if (!unique.length) return {};

  const chunks = chunkArray(unique, 100);
  const map = {};

  for (const chunk of chunks) {
    const users = await safeGet(zd, '/api/v2/users/show_many.json', { ids: chunk.join(',') });
    for (const u of users?.users || []) {
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

function parseTicketSource(t) {
  const channel = t?.via?.channel || null;
  const source = t?.via?.source || null;
  return { channel, via: source || null };
}

function normalizeTicketMetadata(t, userMap = {}) {
  const requester = userMap[t.requester_id] || null;
  const submitter = userMap[t.submitter_id] || null;
  const assignee = userMap[t.assignee_id] || null;
  const { channel, via } = parseTicketSource(t);

  return {
    ticket_id: t.id,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    status: t.status || null,
    priority: t.priority || null,
    subject: t.subject || '',
    tags: Array.isArray(t.tags) ? t.tags : [],
    requester_id: t.requester_id || null,
    requester_name: requester?.name || null,
    requester_email: requester?.email || null,
    submitter_name: submitter?.name || null,
    assignee_name: assignee?.name || null,
    assignee_email: assignee?.email || null,
    channel,
    ticket_source: via,
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

function buildZendeskSearchQuery({
  requester_email,
  ticket_tag,
  status,
  channel,
  free_text,
  start_date,
  end_date,
}) {
  const parts = ['type:ticket'];

  if (requester_email) parts.push(`requester:${requester_email}`);
  if (ticket_tag) parts.push(`tags:${ticket_tag}`);
  if (status) parts.push(`status:${status}`);
  if (channel) parts.push(`via:${channel}`);
  if (start_date) parts.push(`created>=${start_date}`);
  if (end_date) parts.push(`created<=${end_date}`);
  if (free_text) parts.push(free_text);

  return parts.join(' ');
}

function detectAuthorType(user, requesterId, isPublic) {
  const name = (user?.name || '').trim().toLowerCase();

  if (user?.id === requesterId) {
    return 'requester';
  }

  if (KNOWN_BOT_NAMES.includes(name)) {
    return isPublic ? 'bot' : 'internal_bot';
  }

  return isPublic ? 'agent' : 'internal_agent_note';
}

async function buildAuditTimeline({ zd, ticket_id, requesterId, max_text_chars_per_message = 1500 }) {
  const commentsResp = await safeGet(zd, `/api/v2/tickets/${ticket_id}/comments.json`);
  const comments = commentsResp?.comments || [];

  const authorIds = uniq(comments.map((c) => c.author_id));
  const userMap = await fetchUsersByIds(zd, authorIds);

  const messages = [];
  let publicAgentReplies = 0;
  let publicRequesterMessages = 0;
  let internalCommentCount = 0;
  let botMessageCount = 0;

  for (const c of comments) {
    const isPublic = !!c.public;
    const user = userMap[c.author_id] || null;
    const authorType = detectAuthorType(user, requesterId, isPublic);
    const body = (c.plain_body || c.body || '').trim();

    const message = {
      comment_id: c.id || null,
      created_at: c.created_at || null,
      public: isPublic,
      author_id: c.author_id || null,
      author_name: user?.name || null,
      author_email: user?.email || null,
      author_role: user?.role || null,
      author_type: authorType,
      body: truncate(body, max_text_chars_per_message),
    };

    if (isPublic && authorType === 'agent') publicAgentReplies += 1;
    if (isPublic && authorType === 'requester') publicRequesterMessages += 1;
    if (!isPublic) internalCommentCount += 1;
    if (isPublic && authorType === 'bot') botMessageCount += 1;

    messages.push(message);
  }

  return {
    messages,
    public_agent_reply_count: publicAgentReplies,
    public_requester_message_count: publicRequesterMessages,
    internal_comment_count: internalCommentCount,
    bot_message_count: botMessageCount,
  };
}

async function getTicketAuditReviewPayload({
  zd,
  ticket_id,
  max_text_chars_per_message = 1500,
}) {
  const ticketWrap = await safeGet(zd, `/api/v2/tickets/${ticket_id}.json`);
  const t = ticketWrap?.ticket;
  if (!t) return null;

  const userMap = await fetchUsersByIds(
    zd,
    [t.requester_id, t.submitter_id, t.assignee_id].filter(Boolean)
  );

  const metadata = normalizeTicketMetadata(t, userMap);

  const timeline = await buildAuditTimeline({
    zd,
    ticket_id,
    requesterId: t.requester_id,
    max_text_chars_per_message,
  });

  const publicConversation = timeline.messages
    .filter((m) => m.public)
    .map((m) => ({
      created_at: m.created_at,
      author_type: m.author_type,
      author_name: m.author_name,
      author_role: m.author_role,
      body: m.body,
    }));

  const internalComments = timeline.messages
    .filter((m) => !m.public)
    .map((m) => ({
      created_at: m.created_at,
      author_type: m.author_type,
      author_name: m.author_name,
      author_role: m.author_role,
      body: m.body,
    }));

  const requesterComments = publicConversation
    .filter((m) => m.author_type === 'requester')
    .map((m) => ({
      created_at: m.created_at,
      author_name: m.author_name,
      body: m.body,
    }));

  const agentReplies = publicConversation
    .filter((m) => m.author_type === 'agent')
    .map((m) => ({
      created_at: m.created_at,
      author_name: m.author_name,
      body: m.body,
    }));

  const botMessages = publicConversation
    .filter((m) => m.author_type === 'bot')
    .map((m) => ({
      created_at: m.created_at,
      author_name: m.author_name,
      body: m.body,
    }));

  return {
    ...metadata,
    public_agent_reply_count: timeline.public_agent_reply_count,
    public_requester_message_count: timeline.public_requester_message_count,
    internal_comment_count: timeline.internal_comment_count,
    bot_message_count: timeline.bot_message_count,
    requester_comments: requesterComments,
    agent_replies: agentReplies,
    bot_messages: botMessages,
    internal_comments: internalComments,
    full_timeline: timeline.messages.map((m) => ({
      created_at: m.created_at,
      public: m.public,
      author_type: m.author_type,
      author_name: m.author_name,
      author_role: m.author_role,
      body: m.body,
    })),
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= items.length) break;

      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch {
        results[currentIndex] = null;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker()
  );

  await Promise.all(workers);
  return results;
}

function createMcpServer() {
  const server = new McpServer(
    { name: 'zendesk-mcp', version: '7.0.0' },
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
    'search_tickets_metadata',
    {
      description:
        'Search Zendesk tickets by requester email, ticket tag, status, channel, date range, or free text. Returns metadata only.',
      inputSchema: z.object({
        requester_email: z.string().email().optional(),
        ticket_tag: z.string().optional(),
        status: z.string().optional(),
        channel: z.string().optional(),
        free_text: z.string().optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional().default(50),
        max_return: z.coerce.number().int().min(1).max(300).optional().default(100),
        next_page: z.string().optional().nullable(),
      }),
    },
    async ({
      requester_email,
      ticket_tag,
      status,
      channel,
      free_text,
      start_date,
      end_date,
      per_page,
      max_return,
      next_page,
    }) => {
      const zd = zendeskClient();

      const query = buildZendeskSearchQuery({
        requester_email,
        ticket_tag,
        status,
        channel,
        free_text,
        start_date,
        end_date,
      });

      const page = await searchPage(zd, {
        query,
        per_page,
        pageUrl: next_page || null,
      });

      const sliced = (page.results || []).slice(0, max_return);

      const userMap = await fetchUsersByIds(
        zd,
        sliced.flatMap((t) => [t.requester_id, t.submitter_id, t.assignee_id]).filter(Boolean)
      );

      const tickets = sliced.map((t) => normalizeTicketMetadata(t, userMap));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
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
          query,
          tickets,
          next_page: page.next_page,
          count: page.count,
        },
      };
    }
  );

  server.registerTool(
    'get_ticket_audit_review_payload',
    {
      description:
        'Get an audit-ready ticket payload including public conversation, internal comments, requester comments, agent replies, bot messages, and full timeline.',
      inputSchema: z.object({
        ticket_id: z.coerce.number().int(),
        max_text_chars_per_message: z.coerce.number().int().min(200).max(8000).optional().default(1500),
      }),
    },
    async ({ ticket_id, max_text_chars_per_message }) => {
      const zd = zendeskClient();

      const payload = await getTicketAuditReviewPayload({
        zd,
        ticket_id,
        max_text_chars_per_message,
      });

      if (!payload) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found' }) }],
          structuredContent: { error: 'Ticket not found' },
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }
  );

  server.registerTool(
    'get_ticket_audit_review_payload_bulk',
    {
      description:
        'Get audit-ready payloads for multiple tickets. Best used in batches of up to 100 selected ticket IDs.',
      inputSchema: z.object({
        ticket_ids: z.array(z.coerce.number().int()).min(1).max(100),
        max_text_chars_per_message: z.coerce.number().int().min(200).max(8000).optional().default(1200),
      }),
    },
    async ({ ticket_ids, max_text_chars_per_message }) => {
      const zd = zendeskClient();

      const results = await mapWithConcurrency(
        ticket_ids,
        5,
        async (ticket_id) =>
          getTicketAuditReviewPayload({
            zd,
            ticket_id,
            max_text_chars_per_message,
          })
      );

      const filtered = results.filter(Boolean);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tickets: filtered,
                requested_count: ticket_ids.length,
                returned_count: filtered.length,
              },
              null,
              2
            ),
          },
        ],
        structuredContent: {
          tickets: filtered,
          requested_count: ticket_ids.length,
          returned_count: filtered.length,
        },
      };
    }
  );

  return server;
}

// ---------------- Sessions ----------------
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

// ---------------- HTTP app ----------------
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'zendesk-mcp',
  });
});

app.all('/mcp', async (req, res) => {
  try {
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
    console.error('MCP request error:', {
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
      body: req.body,
    });

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Zendesk MCP server listening on port ${PORT}`);
  console.log('MCP endpoint: /mcp');
  console.log(`Shared secret gate: ${MCP_SHARED_SECRET ? 'ENABLED' : 'DISABLED'}`);
});
