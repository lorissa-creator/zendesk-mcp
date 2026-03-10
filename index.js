// index.js — Stable production (Option A: safe defaults, no OOM on Render Free)
//
// Key changes vs your current file:
// - Hard caps + safer defaults (DEFAULT_MAX_TICKETS=500, HARD_MAX_TICKETS=5000)
// - Auto-disable comments for wide windows or large pulls
// - Reduce concurrency to 3 (rate-limit + memory friendly)
// - Avoid duplicating giant payloads in `content` (no JSON.stringify of full dataset)
// - Include group_id + optional group name lookup
// - Compact ticket_source (no raw via object by default)
// - Added get_ticket(ticket_id) for deep qualitative pulls (public+private comments + thread)
//
// Endpoint: POST /mcp (optionally with ?secret=...)
// Health: GET /health

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

// ===== SAFE DEFAULTS FOR 6k/day VOLUME =====
const DEFAULT_MAX_TICKETS = 500; // safe default
const HARD_MAX_TICKETS = 5000; // hard cap on Free Render
const MAX_DAYS_WITHOUT_COMMENTS = 2; // auto-disable comments beyond this window
const MAX_TICKETS_WITH_COMMENTS = 200; // auto-disable comments beyond this count
const DEFAULT_CONCURRENCY = 3; // safer than 6 on small instances

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

function limiter(max = DEFAULT_CONCURRENCY) {
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

function minutesToHours(mins) {
  if (mins == null) return null;
  const n = Number(mins);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 60) * 10) / 10;
}

function computeResolutionHours(created_at, resolved_at) {
  if (!created_at || !resolved_at) return null;
  const ms = new Date(resolved_at).getTime() - new Date(created_at).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.round((ms / 3600000) * 10) / 10;
}

function dateWindowDays(start_date, end_date) {
  const startMs = new Date(`${start_date}T00:00:00Z`).getTime();
  const endMs = end_date
    ? new Date(`${end_date}T23:59:59Z`).getTime()
    : Date.now();
  const days = Math.ceil((endMs - startMs) / (1000 * 60 * 60 * 24));
  return Number.isFinite(days) && days > 0 ? days : 1;
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

async function getCsatScore(zd, ticket_id) {
  const csat = await safeGet(
    zd,
    `/api/v2/tickets/${ticket_id}/satisfaction_rating.json`
  );
  return csat?.satisfaction_rating?.score || null; // "good" | "bad" | null
}

function parseTicketSourceCompact(t) {
  const channel = t?.via?.channel || null;
  const source = t?.via?.source || null;

  return {
    channel,
    ticket_source: {
      from: source?.from?.address || source?.from?.phone || null,
      to: source?.to?.address || null,
      rel: source?.rel || null,
    },
  };
}

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
    public_comments: truncate(pub.join('\n\n---\n\n'), max_text_chars),
    private_comments: truncate(priv.join('\n\n---\n\n'), max_text_chars),
    // Optional full thread for deep analysis (lightly truncated)
    thread: list.map((c) => ({
      author_id: c.author_id || null,
      created_at: c.created_at || null,
      public: c.public ?? true,
      body: truncate((c.body || '').trim(), max_text_chars),
    })),
  };
}

async function fetchUsersByIds(zd, ids) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return {};
  const users = await safeGet(zd, '/api/v2/users/show_many.json', {
    ids: unique.join(','),
  });
  const map = {};
  for (const u of users?.users || []) map[u.id] = u;
  return map;
}

async function fetchGroupsByIds(zd, ids) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return {};
  // No show_many for groups in older Zendesk APIs; do per-group (limited by HARD_MAX_TICKETS anyway)
  const runLimited = limiter(3);
  const map = {};
  await Promise.all(
    unique.slice(0, 200).map((gid) =>
      runLimited(async () => {
        const g = await safeGet(zd, `/api/v2/groups/${gid}.json`);
        if (g?.group) map[gid] = g.group;
      })
    )
  );
  return map;
}

// Helper: paginate Zendesk Search API (bounded)
async function fetchAllSearch(zd, firstUrl, maxTickets = 500, pageLimit = 50) {
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

function buildNormalizedRecord({
  t,
  requester,
  submitter,
  assignee,
  group,
  csat_score,
  metrics,
  resolved_at,
  resolution_time_hrs,
  commentBlobs,
}) {
  const src = parseTicketSourceCompact(t);

  return {
    ticket_id: t.id,
    created_at: t.created_at || null,
    closed_at: t.closed_at || null,
    resolved_at: resolved_at || t.solved_at || t.closed_at || null,

    status: t.status || null,
    priority: t.priority || 'normal',

    tags: t.tags || [],
    subject: t.subject || '',

    requester_email: requester?.email || null,
    submitter_name: submitter?.name || null,
    agent_name: assignee?.name || null,

    group_id: t.group_id || null,
    group_name: group?.name || null,

    // Times
    first_reply_time_mins: metrics?.first_reply_time_mins ?? null,
    reply_time_mins: metrics?.reply_time_mins ?? null,
    resolution_time_mins: metrics?.resolution_time_mins ?? null,
    resolution_time_hrs: resolution_time_hrs ?? null,
    resolution_time_hrs_from_metrics: metrics?.resolution_time_hrs_from_metrics ?? null,

    // CSAT
    csat_score: csat_score || null,

    // Comments (only when enabled / safe)
    public_comment: commentBlobs?.public_comments ?? null,
    private_comment: commentBlobs?.private_comments ?? null,

    // Source
    channel: src.channel,
    ticket_source: src.ticket_source,
  };
}

// ---- MCP server factory (NEW SERVER PER SESSION) ----
function createMcpServer() {
  const server = new McpServer(
    { name: 'zendesk-readonly-mcp', version: '3.1.0' },
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
   * list_tickets_since — Incremental Export, safe defaults
   */
  server.registerTool(
    'list_tickets_since',
    {
      description:
        'List tickets via Incremental Export. Safe for high volume: use date windows + limits. Comments auto-disabled for wide pulls.',
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-01-01'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

        max_tickets: z.number().int().min(1).max(HARD_MAX_TICKETS).optional().default(DEFAULT_MAX_TICKETS),

        include_csat: z.boolean().optional().default(true),
        include_metrics: z.boolean().optional().default(true),
        include_comments: z.boolean().optional().default(false),
        include_group_name: z.boolean().optional().default(false),

        include_resolved_audits: z.boolean().optional().default(false),
        max_text_chars: z.number().int().min(200).max(10000).optional().default(2000),

        // Filters (cheap)
        channel: z.string().optional(), // email/chat/phone/web/social...
        tag: z.string().optional(),
        status: z.string().optional(),
        agent_name_contains: z.string().optional(),
        only_bad_csat: z.boolean().optional().default(false),
        resolution_time_gt_hrs: z.number().min(0).optional(),
      }),
    },
    async (args) => {
      const {
        start_date,
        end_date,
        include_csat,
        include_metrics,
        include_comments,
        include_group_name,
        include_resolved_audits,
        max_text_chars,
        channel,
        tag,
        status,
        agent_name_contains,
        only_bad_csat,
        resolution_time_gt_hrs,
      } = args;

      const requestedMax = Number(args.max_tickets ?? DEFAULT_MAX_TICKETS);
      const safeMax = Math.min(requestedMax, HARD_MAX_TICKETS);

      const zd = zendeskClient();
      const runLimited = limiter(DEFAULT_CONCURRENCY);

      const startUnix = Math.floor(new Date(`${start_date}T00:00:00Z`).getTime() / 1000);
      if (!Number.isFinite(startUnix) || startUnix <= 0) throw new Error('Invalid start_date. Use YYYY-MM-DD.');

      const endMs = end_date ? new Date(`${end_date}T23:59:59Z`).getTime() : null;

      // Auto-disable comments if window too wide or too many tickets
      const days = dateWindowDays(start_date, end_date);
      const safeIncludeComments =
        include_comments && days <= MAX_DAYS_WITHOUT_COMMENTS && safeMax <= MAX_TICKETS_WITH_COMMENTS;

      let nextUrl = `/api/v2/incremental/tickets.json?start_time=${startUnix}`;
      const collected = [];

      while (nextUrl && collected.length < safeMax) {
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

          if (status && t.status !== status) continue;
          if (channel && (t?.via?.channel || null) !== channel) continue;
          if (tag && !(t.tags || []).includes(tag)) continue;

          collected.push(t);
          if (collected.length >= safeMax) break;
        }

        if (!nextUrl) break;
        if (data.end_of_stream) break;
        nextUrl = data.next_page || null;
      }

      // Batch user fetch
      const requesterIds = collected.map((t) => t.requester_id).filter(Boolean);
      const submitterIds = collected.map((t) => t.submitter_id).filter(Boolean);
      const assigneeIds = collected.map((t) => t.assignee_id).filter(Boolean);
      const userMap = await fetchUsersByIds(zd, [...requesterIds, ...submitterIds, ...assigneeIds]);

      const groupIds = include_group_name ? collected.map((t) => t.group_id).filter(Boolean) : [];
      const groupMap = include_group_name ? await fetchGroupsByIds(zd, groupIds) : {};

      const tickets = await Promise.all(
        collected.map((t) =>
          runLimited(async () => {
            const ticket_id = t.id;

            const requester = userMap[t.requester_id] || null;
            const submitter = userMap[t.submitter_id] || null;
            const assignee = userMap[t.assignee_id] || null;
            const group = include_group_name ? groupMap[t.group_id] || null : null;

            if (agent_name_contains) {
              const nm = (assignee?.name || '').toLowerCase();
              if (!nm.includes(agent_name_contains.toLowerCase())) return null;
            }

            const { resolved_at, resolution_time_hrs } = await resolveResolvedAt({
              zd,
              ticket_id,
              created_at: t.created_at,
              solved_at: t.solved_at,
              closed_at: t.closed_at,
              include_resolved_audits,
            });

            const csat_score = include_csat ? await getCsatScore(zd, ticket_id) : null;
            if (only_bad_csat && csat_score !== 'bad') return null;

            const metrics = include_metrics ? await getTicketMetrics(zd, ticket_id) : null;

            if (resolution_time_gt_hrs != null) {
              const hrsFromMetrics = metrics?.resolution_time_hrs_from_metrics ?? null;
              const hrsFallback = resolution_time_hrs ?? null;
              const hrs = hrsFromMetrics ?? hrsFallback;
              if (hrs == null || hrs <= resolution_time_gt_hrs) return null;
            }

            const commentBlobs = safeIncludeComments
              ? await buildPublicPrivateComments({ zd, ticket_id, max_text_chars })
              : { public_comments: null, private_comments: null, thread: null };

            return buildNormalizedRecord({
              t,
              requester,
              submitter,
              assignee,
              group,
              csat_score,
              metrics,
              resolved_at,
              resolution_time_hrs,
              commentBlobs,
            });
          })
        )
      );

      const cleaned = tickets.filter(Boolean);

      return {
        content: [
          {
            type: 'text',
            text: `Returned ${cleaned.length} tickets. (comments: ${safeIncludeComments ? 'ON' : 'OFF'})`,
          },
        ],
        structuredContent: {
          meta: {
            start_date,
            end_date: end_date || null,
            requested_max: requestedMax,
            returned: cleaned.length,
            comments_enabled: safeIncludeComments,
            note:
              safeIncludeComments
                ? null
                : 'Comments are disabled for wide windows or large pulls. Use get_ticket(ticket_id) for qualitative deep dives.',
          },
          tickets: cleaned,
        },
      };
    }
  );

  /**
   * search_tickets — Search API (fast targeting). Safe defaults.
   */
  server.registerTool(
    'search_tickets',
    {
      description:
        'Fast Zendesk ticket search (Search API). Best for tag/channel/agent/email filters. Comments auto-disabled for large pulls.',
      inputSchema: z.object({
        query: z.string().min(1),

        per_page: z.number().int().min(1).max(100).optional().default(100),
        max_tickets: z.number().int().min(1).max(HARD_MAX_TICKETS).optional().default(DEFAULT_MAX_TICKETS),

        include_csat: z.boolean().optional().default(true),
        include_metrics: z.boolean().optional().default(true),
        include_comments: z.boolean().optional().default(false),
        include_group_name: z.boolean().optional().default(false),

        include_resolved_audits: z.boolean().optional().default(false),
        max_text_chars: z.number().int().min(200).max(10000).optional().default(2000),

        only_bad_csat: z.boolean().optional().default(false),
        resolution_time_gt_hrs: z.number().min(0).optional(),
      }),
    },
    async (args) => {
      const {
        query,
        per_page,
        include_csat,
        include_metrics,
        include_comments,
        include_group_name,
        include_resolved_audits,
        max_text_chars,
        only_bad_csat,
        resolution_time_gt_hrs,
      } = args;

      const requestedMax = Number(args.max_tickets ?? DEFAULT_MAX_TICKETS);
      const safeMax = Math.min(requestedMax, HARD_MAX_TICKETS);

      const zd = zendeskClient();
      const runLimited = limiter(DEFAULT_CONCURRENCY);

      const safeIncludeComments =
        include_comments && safeMax <= MAX_TICKETS_WITH_COMMENTS;

      const firstUrl = `/api/v2/search.json?${new URLSearchParams({
        query,
        per_page: String(per_page),
        sort_by: 'created_at',
        sort_order: 'desc',
      }).toString()}`;

      const raw = await fetchAllSearch(zd, firstUrl, safeMax, 50);

      // Batch user fetch
      const requesterIds = raw.map((t) => t.requester_id).filter(Boolean);
      const submitterIds = raw.map((t) => t.submitter_id).filter(Boolean);
      const assigneeIds = raw.map((t) => t.assignee_id).filter(Boolean);
      const userMap = await fetchUsersByIds(zd, [...requesterIds, ...submitterIds, ...assigneeIds]);

      const groupIds = include_group_name ? raw.map((t) => t.group_id).filter(Boolean) : [];
      const groupMap = include_group_name ? await fetchGroupsByIds(zd, groupIds) : {};

      const tickets = await Promise.all(
        raw.map((t) =>
          runLimited(async () => {
            const ticket_id = t.id;

            const requester = userMap[t.requester_id] || null;
            const submitter = userMap[t.submitter_id] || null;
            const assignee = userMap[t.assignee_id] || null;
            const group = include_group_name ? groupMap[t.group_id] || null : null;

            const { resolved_at, resolution_time_hrs } = await resolveResolvedAt({
              zd,
              ticket_id,
              created_at: t.created_at,
              solved_at: t.solved_at,
              closed_at: t.closed_at,
              include_resolved_audits,
            });

            const csat_score = include_csat ? await getCsatScore(zd, ticket_id) : null;
            if (only_bad_csat && csat_score !== 'bad') return null;

            const metrics = include_metrics ? await getTicketMetrics(zd, ticket_id) : null;

            if (resolution_time_gt_hrs != null) {
              const hrsFromMetrics = metrics?.resolution_time_hrs_from_metrics ?? null;
              const hrsFallback = resolution_time_hrs ?? null;
              const hrs = hrsFromMetrics ?? hrsFallback;
              if (hrs == null || hrs <= resolution_time_gt_hrs) return null;
            }

            const commentBlobs = safeIncludeComments
              ? await buildPublicPrivateComments({ zd, ticket_id, max_text_chars })
              : { public_comments: null, private_comments: null, thread: null };

            return buildNormalizedRecord({
              t,
              requester,
              submitter,
              assignee,
              group,
              csat_score,
              metrics,
              resolved_at,
              resolution_time_hrs,
              commentBlobs,
            });
          })
        )
      );

      const cleaned = tickets.filter(Boolean);

      return {
        content: [
          {
            type: 'text',
            text: `Returned ${cleaned.length} tickets. (comments: ${safeIncludeComments ? 'ON' : 'OFF'})`,
          },
        ],
        structuredContent: {
          meta: {
            query,
            requested_max: requestedMax,
            returned: cleaned.length,
            comments_enabled: safeIncludeComments,
            note:
              safeIncludeComments
                ? null
                : 'Comments are disabled for large pulls. Use get_ticket(ticket_id) for qualitative deep dives.',
          },
          tickets: cleaned,
        },
      };
    }
  );

  /**
   * get_ticket — single ticket deep dive (qualitative)
   * Always safe: one ticket at a time.
   */
  server.registerTool(
    'get_ticket',
    {
      description:
        'Get a single ticket with public/private comments + thread (for qualitative analysis).',
      inputSchema: z.object({
        ticket_id: z.number().int(),
        include_csat: z.boolean().optional().default(true),
        include_metrics: z.boolean().optional().default(true),
        include_group_name: z.boolean().optional().default(true),
        include_resolved_audits: z.boolean().optional().default(false),
        max_text_chars: z.number().int().min(200).max(10000).optional().default(5000),
      }),
    },
    async ({
      ticket_id,
      include_csat,
      include_metrics,
      include_group_name,
      include_resolved_audits,
      max_text_chars,
    }) => {
      const zd = zendeskClient();

      const wrap = await safeGet(zd, `/api/v2/tickets/${ticket_id}.json`);
      const t = wrap?.ticket;
      if (!t) {
        return {
          content: [{ type: 'text', text: 'Ticket not found.' }],
          structuredContent: { error: 'Ticket not found' },
        };
      }

      const userMap = await fetchUsersByIds(zd, [t.requester_id, t.submitter_id, t.assignee_id]);
      const requester = userMap[t.requester_id] || null;
      const submitter = userMap[t.submitter_id] || null;
      const assignee = userMap[t.assignee_id] || null;

      const groupMap = include_group_name ? await fetchGroupsByIds(zd, [t.group_id]) : {};
      const group = include_group_name ? groupMap[t.group_id] || null : null;

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

      const commentBlobs = await buildPublicPrivateComments({ zd, ticket_id, max_text_chars });

      const normalized = buildNormalizedRecord({
        t,
        requester,
        submitter,
        assignee,
        group,
        csat_score,
        metrics,
        resolved_at,
        resolution_time_hrs,
        commentBlobs,
      });

      return {
        content: [{ type: 'text', text: `Fetched ticket ${ticket_id}.` }],
        structuredContent: {
          ticket: normalized,
          thread: commentBlobs.thread,
          zendesk_url: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${ticket_id}`,
        },
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
      try {
        s.transport.close();
      } catch {}
      try {
        s.server.close();
      } catch {}
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
