/**
 * index.js — Zendesk Read-only MCP (Production / Memory-safe)
 *
 * ✅ Fixes heap OOM by:
 * - Bulk tools return METADATA ONLY (no comments/csat/metrics in bulk)
 * - Pagination/cursors (no giant arrays)
 * - Deep-dive tool get_ticket(ticket_id) fetches heavy data per ticket
 * - No Promise.all on huge sets
 *
 * Endpoints:
 * - POST /mcp?secret=YOUR_SECRET   (optional shared secret gate)
 * - GET  /health
 *
 * Tools:
 * - ping
 * - list_tickets_since   (Incremental Export; metadata-only; paginated)
 * - search_tickets       (Search API; metadata-only; paginated)
 * - get_ticket           (Full thread + public/private comments + csat + metrics)
 *
 * Render start command (recommended):
 *   node --max-old-space-size=2048 index.js
 */

import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = process.env.PORT || 3000;

// Optional shared secret: Claude-friendly gate using query param ?secret=...
const MCP_SHARED_SECRET = (process.env.MCP_SHARED_SECRET || '').trim();

// Zendesk creds (API token)
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
    const r = await zd.get(url, params ? { params } : undefined);
    return r.data;
  } catch (e) {
    return null;
  }
}

function truncate(s, maxChars = 8000) {
  if (!s) return null;
  const t = String(s);
  return t.length <= maxChars ? t : t.slice(0, maxChars) + '…';
}

function minutesToHours(mins) {
  if (mins == null) return null;
  const n = Number(mins);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 60) * 10) / 10;
}

function computeResolutionHours(created_at, resolved_at) {
  if (!created_at || !resolved_at) return null;
  const ms = new Date(resolved_at).getTime() - new Date(created_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round((ms / 3600000) * 10) / 10;
}

function parseTicketSource(t) {
  const channel = t?.via?.channel || null;
  const source = t?.via?.source || null;
  return { channel, via: source || null };
}

// --- Users (names/emails) ---
async function fetchUsersByIds(zd, ids) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return {};
  const users = await safeGet(zd, '/api/v2/users/show_many.json', { ids: unique.join(',') });
  const map = {};
  for (const u of users?.users || []) map[u.id] = u;
  return map;
}

// --- Comments (split public/private) ---
async function buildPublicPrivateComments({ zd, ticket_id, max_text_chars }) {
  const comments = await safeGet(zd, `/api/v2/tickets/${ticket_id}/comments.json`);
  const list = comments?.comments || [];
  const pub = [];
  const priv = [];
  for (const c of list) {
    const body = (c.body || '').trim();
    if (!body) continue;
    if (c.public) pub.push(body);
    else priv.push(body);
  }
  return {
    public_comment: truncate(pub.join('\n\n---\n\n'), max_text_chars),
    private_comment: truncate(priv.join('\n\n---\n\n'), max_text_chars),
  };
}

// --- CSAT ---
async function getCsatScore(zd, ticket_id) {
  const csat = await safeGet(zd, `/api/v2/tickets/${ticket_id}/satisfaction_rating.json`);
  return csat?.satisfaction_rating?.score || null; // "good" | "bad" | null
}

// --- Metrics ---
async function getTicketMetrics(zd, ticket_id) {
  const m = await safeGet(zd, `/api/v2/tickets/${ticket_id}/metrics.json`);
  const metrics = m?.ticket_metric;
  if (!metrics) return null;

  const firstReplyMin = metrics.first_reply_time_in_minutes?.calendar ?? null;
  const replyTimeMin = metrics.reply_time_in_minutes?.calendar ?? null;
  const fullResMin = metrics.full_resolution_time_in_minutes?.calendar ?? null;

  return {
    first_reply_time_mins: firstReplyMin,
    reply_time_mins: replyTimeMin,
    resolution_time_mins: fullResMin,
    resolution_time_hrs_from_metrics: minutesToHours(fullResMin),
  };
}

// --- Resolve resolved_at (optional audits; heavy) ---
async function resolveResolvedAt({ zd, ticket_id, created_at, solved_at, closed_at, include_resolved_audits }) {
  let resolved_at = solved_at || closed_at || null;
  if (!resolved_at && include_resolved_audits) {
    const audits = await safeGet(zd, `/api/v2/tickets/${ticket_id}/audits.json`);
    if (audits?.audits?.length) {
      for (const a of audits.audits) {
        const statusChange = (a.events || []).find(
          (e) => e.field_name === 'status' && (e.value === 'solved' || e.value === 'closed')
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

// --- Normalized: METADATA ONLY for bulk tools ---
function normalizeTicketMetadata(t, userMap = {}) {
  const { channel, via } = parseTicketSource(t);

  const requester = userMap[t.requester_id] || null;
  const submitter = userMap[t.submitter_id] || null;
  const assignee = userMap[t.assignee_id] || null;

  return {
    ticket_id: t.id,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    closed_at: t.closed_at || null,
    solved_at: t.solved_at || null,

    status: t.status || null,
    priority: t.priority || 'normal',
    subject: t.subject || '',
    tags: t.tags || [],

    requester_email: requester?.email || null,
    submitter_name: submitter?.name || null,
    agent_name: assignee?.name || null,

    // If your Zendesk includes group_id and you want group name later,
    // we return group_id here (name can be resolved separately if needed).
    group_id: t.group_id || null,

    channel,
    ticket_source: via,
  };
}

// --- Search API fetch page (returns results + next_page) ---
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

// --- Incremental Export page (returns tickets + next_page) ---
async function incrementalTicketsPage(zd, { start_time_unix, pageUrl = null }) {
  const url = pageUrl || `/api/v2/incremental/tickets.json?start_time=${start_time_unix}`;
  const resp = url.startsWith('http') ? await zd.get(url, { baseURL: '' }) : await zd.get(url);
  const data = resp.data || {};
  return {
    tickets: data.tickets || [],
    next_page: data.next_page || null,
    end_of_stream: !!data.end_of_stream,
  };
}

// ---------------- MCP server factory ----------------
function createMcpServer() {
  const server = new McpServer(
    { name: 'zendesk-readonly-mcp', version: '4.0.0' },
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
   * list_tickets_since (Incremental Export)
   * ✅ Metadata only
   * ✅ Paginated: returns next_page cursor (URL)
   * ✅ Filters: channel, tag, status
   *
   * Use this for: "ALL tickets since 2026-01-01" (but page through!)
   */
  server.registerTool(
    'list_tickets_since',
    {
      description:
        'List tickets since start_date using Incremental Export (metadata only, paginated). Use next_page to continue.',
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().default('2026-01-01'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

        // Cursor returned by previous call (data.next_page). Pass it to continue.
        next_page: z.string().optional().nullable(),

        // Hard cap per call (keeps memory safe)
        max_return: z.number().int().min(1).max(2000).optional().default(1000),

        // Lightweight filters
        channel: z.string().optional(),
        tag: z.string().optional(),
        status: z.string().optional(),

        // If you need names/emails in bulk output
        include_user_fields: z.boolean().optional().default(true),
      }),
    },
    async ({ start_date, end_date, next_page, max_return, channel, tag, status, include_user_fields }) => {
      const zd = zendeskClient();

      const startUnix = Math.floor(new Date(`${start_date}T00:00:00Z`).getTime() / 1000);
      if (!Number.isFinite(startUnix) || startUnix <= 0) throw new Error('Invalid start_date. Use YYYY-MM-DD.');

      const endMs = end_date ? new Date(`${end_date}T23:59:59Z`).getTime() : null;

      // Fetch 1 incremental page (already paginated by Zendesk)
      const page = await incrementalTicketsPage(zd, { start_time_unix: startUnix, pageUrl: next_page || null });

      // Filter + cap to keep response small
      const filtered = [];
      for (const t of page.tickets) {
        if (endMs) {
          const createdMs = new Date(t.created_at).getTime();
          if (!Number.isNaN(createdMs) && createdMs > endMs) break;
        }
        if (status && t.status !== status) continue;
        if (channel && (t?.via?.channel || null) !== channel) continue;
        if (tag && !(t.tags || []).includes(tag)) continue;

        filtered.push(t);
        if (filtered.length >= max_return) break;
      }

      // Resolve users in bulk (optional; still safe for <=2000)
      let userMap = {};
      if (include_user_fields) {
        const requesterIds = filtered.map((t) => t.requester_id).filter(Boolean);
        const submitterIds = filtered.map((t) => t.submitter_id).filter(Boolean);
        const assigneeIds = filtered.map((t) => t.assignee_id).filter(Boolean);
        userMap = await fetchUsersByIds(zd, [...requesterIds, ...submitterIds, ...assigneeIds]);
      }

      const tickets = filtered.map((t) => normalizeTicketMetadata(t, userMap));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tickets,
                next_page: page.next_page,
                end_of_stream: page.end_of_stream,
              },
              null,
              2
            ),
          },
        ],
        structuredContent: {
          tickets,
          next_page: page.next_page,
          end_of_stream: page.end_of_stream,
        },
      };
    }
  );

  /**
   * search_tickets (Search API)
   * ✅ Metadata only
   * ✅ Paginated via next_page URL
   *
   * Best for: requester email, tags, channel, agent name (search query)
   */
  server.registerTool(
    'search_tickets',
    {
      description:
        'Search tickets using Zendesk Search API (metadata only, paginated). Use next_page to continue.',
      inputSchema: z.object({
        query: z.string().min(1).describe(
          'Zendesk search query. Examples: type:ticket created>=2026-01-01 requester:email@domain.com tags:checkout via:chat'
        ),
        per_page: z.number().int().min(1).max(100).optional().default(100),
        next_page: z.string().optional().nullable(),
        max_return: z.number().int().min(1).max(1000).optional().default(300),
        include_user_fields: z.boolean().optional().default(true),
      }),
    },
    async ({ query, per_page, next_page, max_return, include_user_fields }) => {
      const zd = zendeskClient();

      const page = await searchPage(zd, { query, per_page, pageUrl: next_page || null });

      // cap to keep safe
      const sliced = (page.results || []).slice(0, max_return);

      let userMap = {};
      if (include_user_fields) {
        const requesterIds = sliced.map((t) => t.requester_id).filter(Boolean);
        const submitterIds = sliced.map((t) => t.submitter_id).filter(Boolean);
        const assigneeIds = sliced.map((t) => t.assignee_id).filter(Boolean);
        userMap = await fetchUsersByIds(zd, [...requesterIds, ...submitterIds, ...assigneeIds]);
      }

      const tickets = sliced.map((t) => normalizeTicketMetadata(t, userMap));

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

  /**
   * get_ticket(ticket_id)
   * ✅ Full thread: public + private comments
   * ✅ CSAT score
   * ✅ Ticket metrics (first reply, reply time, full resolution)
   * ✅ resolved_at (optional audits if you enable it)
   *
   * Use this only for a small set of ticket IDs (sample / bad CSAT / slow resolution).
   */
  server.registerTool(
    'get_ticket',
    {
      description:
        'Get one ticket full detail: CSAT, metrics, and public/private comments for deep qualitative analysis.',
      inputSchema: z.object({
        ticket_id: z.number().int(),
        include_comments: z.boolean().optional().default(true),
        include_csat: z.boolean().optional().default(true),
        include_metrics: z.boolean().optional().default(true),
        include_resolved_audits: z.boolean().optional().default(false),
        max_text_chars: z.number().int().min(200).max(20000).optional().default(8000),
      }),
    },
    async ({ ticket_id, include_comments, include_csat, include_metrics, include_resolved_audits, max_text_chars }) => {
      const zd = zendeskClient();

      const ticketWrap = await safeGet(zd, `/api/v2/tickets/${ticket_id}.json`);
      const t = ticketWrap?.ticket;
      if (!t) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found' }) }],
          structuredContent: { error: 'Ticket not found' },
        };
      }

      const userMap = await fetchUsersByIds(zd, [t.requester_id, t.submitter_id, t.assignee_id].filter(Boolean));

      const { resolved_at, resolution_time_hrs } = await resolveResolvedAt({
        zd,
        ticket_id,
        created_at: t.created_at,
        solved_at: t.solved_at,
        closed_at: t.closed_at,
        include_resolved_audits,
      });

      const csat_score = include_csat ? await getCsatScore(zd, ticket_id) : null;
      const metrics = include_metrics ? await getTicketMetrics(zd, ticket_id) : null;

      const comments = include_comments
        ? await buildPublicPrivateComments({ zd, ticket_id, max_text_chars })
        : { public_comment: null, private_comment: null };

      const base = normalizeTicketMetadata(t, userMap);
      const detailed = {
        ...base,
        resolved_at: resolved_at || t.solved_at || t.closed_at || null,
        resolution_time_hrs: resolution_time_hrs ?? null,

        csat_score: csat_score ?? null,

        first_reply_time_mins: metrics?.first_reply_time_mins ?? null,
        reply_time_mins: metrics?.reply_time_mins ?? null,
        resolution_time_mins: metrics?.resolution_time_mins ?? null,
        resolution_time_hrs_from_metrics: metrics?.resolution_time_hrs_from_metrics ?? null,

        public_comment: comments.public_comment,
        private_comment: comments.private_comment,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(detailed, null, 2) }],
        structuredContent: detailed,
      };
    }
  );

  return server;
}

// ---------------- Sessions (per connection) ----------------
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
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/mcp', async (req, res) => {
  try {
    // Shared secret gate
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

app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').send('Method Not Allowed'));

app.listen(PORT, () => {
  console.log(`Zendesk MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Shared secret gate: ${MCP_SHARED_SECRET ? 'ENABLED' : 'DISABLED'}`);
});
