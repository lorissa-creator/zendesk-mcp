/**
 * index.js — Zendesk Audit-Ready Read-only MCP
 *
 * Purpose:
 * - Search tickets for audit workflows
 * - Return structured thread data for Claude-based QA / multi-touch analysis
 *
 * Key features:
 * - MCP endpoint via app.all('/mcp')
 * - Search by requester email, ticket tags, status, channel, assignee, date range
 * - Includes requester/user tags
 * - Structured conversation timeline
 * - Counts public touches
 * - Multi-touch candidate filtering
 * - Audit payload per ticket
 *
 * Recommended Render start command:
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

// Optional shared secret
const MCP_SHARED_SECRET = (process.env.MCP_SHARED_SECRET || '').trim();

// Zendesk creds
const ZENDESK_SUBDOMAIN = (process.env.ZENDESK_SUBDOMAIN || '').trim();
const ZENDESK_EMAIL = (process.env.ZENDESK_EMAIL || '').trim();
const ZENDESK_API_TOKEN = (process.env.ZENDESK_API_TOKEN || '').trim();

// Optional: comma-separated known bot emails or names
const KNOWN_BOT_EMAILS = (process.env.KNOWN_BOT_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const KNOWN_BOT_NAMES = (process.env.KNOWN_BOT_NAMES || '')
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
  } catch (e) {
    return null;
  }
}

function truncate(s, maxChars = 8000) {
  if (s == null) return null;
  const t = String(s);
  return t.length <= maxChars ? t : `${t.slice(0, maxChars)}…`;
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
        organization_id: u.organization_id || null,
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
    const groups = await safeGet(zd, '/api/v2/groups/show_many.json', { ids: chunk.join(',') });
    for (const g of groups?.groups || []) {
      map[g.id] = {
        id: g.id,
        name: g.name || null,
      };
    }
  }

  return map;
}

async function fetchOrganizationsByIds(zd, ids) {
  const unique = uniq(ids);
  if (!unique.length) return {};

  const chunks = chunkArray(unique, 100);
  const map = {};

  for (const chunk of chunks) {
    const orgs = await safeGet(zd, '/api/v2/organizations/show_many.json', { ids: chunk.join(',') });
    for (const o of orgs?.organizations || []) {
      map[o.id] = {
        id: o.id,
        name: o.name || null,
        tags: Array.isArray(o.tags) ? o.tags : [],
      };
    }
  }

  return map;
}

async function getCsatScore(zd, ticket_id) {
  const csat = await safeGet(zd, `/api/v2/tickets/${ticket_id}/satisfaction_rating.json`);
  return csat?.satisfaction_rating?.score || null; // good | bad | null
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

function detectAuthorType(user, requesterId) {
  if (!user) return 'unknown';

  const email = (user.email || '').toLowerCase();
  const name = (user.name || '').toLowerCase();
  const role = (user.role || '').toLowerCase();

  if (user.id === requesterId) return 'requester';

  if (KNOWN_BOT_EMAILS.includes(email) || KNOWN_BOT_NAMES.includes(name)) return 'bot';

  if (role === 'agent' || role === 'admin') return 'agent';

  if (role === 'end-user') return 'end_user';

  if (role === 'system') return 'system';

  return 'unknown';
}

function normalizeTicketMetadata(t, userMap = {}, groupMap = {}) {
  const { channel, via } = parseTicketSource(t);

  const requester = userMap[t.requester_id] || null;
  const submitter = userMap[t.submitter_id] || null;
  const assignee = userMap[t.assignee_id] || null;
  const group = groupMap[t.group_id] || null;

  return {
    ticket_id: t.id,
    external_id: t.external_id || null,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    closed_at: t.closed_at || null,
    solved_at: t.solved_at || null,

    status: t.status || null,
    priority: t.priority || 'normal',
    subject: t.subject || '',
    tags: Array.isArray(t.tags) ? t.tags : [],

    requester_id: t.requester_id || null,
    requester_name: requester?.name || null,
    requester_email: requester?.email || null,
    requester_role: requester?.role || null,
    requester_tags: requester?.tags || [],

    submitter_id: t.submitter_id || null,
    submitter_name: submitter?.name || null,

    assignee_id: t.assignee_id || null,
    agent_name: assignee?.name || null,
    assignee_email: assignee?.email || null,

    group_id: t.group_id || null,
    group_name: group?.name || null,

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

function buildZendeskSearchQuery({
  requester_email,
  ticket_tag,
  status,
  channel,
  assignee_name,
  group_id,
  brand_tag,
  free_text,
  start_date,
  end_date,
}) {
  const parts = ['type:ticket'];

  if (requester_email) parts.push(`requester:${requester_email}`);
  if (ticket_tag) parts.push(`tags:${ticket_tag}`);
  if (brand_tag) parts.push(`tags:${brand_tag}`);
  if (status) parts.push(`status:${status}`);
  if (channel) parts.push(`via:${channel}`);
  if (assignee_name) parts.push(`assignee:"${assignee_name}"`);
  if (group_id) parts.push(`group_id:${group_id}`);
  if (start_date) parts.push(`created>=${start_date}`);
  if (end_date) parts.push(`created<=${end_date}`);
  if (free_text) parts.push(free_text);

  return parts.join(' ');
}

async function buildConversationTimeline({ zd, ticket_id, requesterId, max_text_chars_per_message = 4000 }) {
  const commentsResp = await safeGet(zd, `/api/v2/tickets/${ticket_id}/comments.json`);
  const comments = commentsResp?.comments || [];

  const authorIds = uniq(comments.map((c) => c.author_id));
  const userMap = await fetchUsersByIds(zd, authorIds);

  const messages = [];
  let publicAgentReplies = 0;
  let publicCustomerMessages = 0;
  let botMessages = 0;

  for (const c of comments) {
    const user = userMap[c.author_id] || null;
    const authorType = detectAuthorType(user, requesterId);
    const body = (c.plain_body || c.body || '').trim();

    const message = {
      comment_id: c.id || null,
      created_at: c.created_at || null,
      public: !!c.public,
      author_id: c.author_id || null,
      author_name: user?.name || null,
      author_email: user?.email || null,
      author_role: user?.role || null,
      author_type: authorType,
      body: truncate(body, max_text_chars_per_message),
    };

    if (message.public && message.author_type === 'agent') publicAgentReplies += 1;
    if (message.public && message.author_type === 'requester') publicCustomerMessages += 1;
    if (message.public && message.author_type === 'bot') botMessages += 1;

    messages.push(message);
  }

  return {
    messages,
    public_agent_reply_count: publicAgentReplies,
    public_requester_message_count: publicCustomerMessages,
    public_touch_count: publicAgentReplies + publicCustomerMessages + botMessages,
    bot_message_count: botMessages,
  };
}

function inferHandlingFlow(messages) {
  const publicMsgs = (messages || []).filter((m) => m.public);

  if (!publicMsgs.length) return 'Unknown';

  const humanAgents = publicMsgs.filter((m) => m.author_type === 'agent');
  const bots = publicMsgs.filter((m) => m.author_type === 'bot');

  if (bots.length > 0 && humanAgents.length === 0) return 'Bot Only';

  if (bots.length > 0 && humanAgents.length > 0) {
    const firstBotIdx = publicMsgs.findIndex((m) => m.author_type === 'bot');
    const firstAgentIdx = publicMsgs.findIndex((m) => m.author_type === 'agent');

    if (firstBotIdx !== -1 && firstAgentIdx !== -1 && firstBotIdx < firstAgentIdx) {
      const distinctAgents = uniq(humanAgents.map((m) => m.author_name || m.author_id));
      return distinctAgents.length > 1 ? 'Agent Multi-touch' : 'Bot → Agent';
    }
  }

  if (humanAgents.length > 0) {
    const distinctAgents = uniq(humanAgents.map((m) => m.author_name || m.author_id));
    return distinctAgents.length > 1 ? 'Agent Multi-touch' : 'Agent Direct';
  }

  return 'Unknown';
}

function classifyTouchBucket(publicAgentReplyCount) {
  if (publicAgentReplyCount <= 1) return '1 Touch';
  if (publicAgentReplyCount === 2) return '2 Touches';
  if (publicAgentReplyCount === 3) return '3 Touches';
  if (publicAgentReplyCount === 4) return '4 Touches';
  return '5+ Touches';
}

function buildConversationText(messages, opts = {}) {
  const { publicOnly = false, maxCombinedChars = 30000 } = opts;
  const selected = publicOnly ? messages.filter((m) => m.public) : messages;

  const joined = selected
    .map((m) => {
      const visibility = m.public ? 'public' : 'private';
      const who = m.author_name || m.author_type || 'unknown';
      const ts = m.created_at || '';
      return `[${ts}] [${visibility}] [${m.author_type}] ${who}: ${m.body || ''}`;
    })
    .join('\n\n');

  return truncate(joined, maxCombinedChars);
}

async function getTicketAuditPayload({
  zd,
  ticket_id,
  include_comments = true,
  include_csat = true,
  include_metrics = true,
  include_resolved_audits = false,
  max_text_chars_per_message = 4000,
  max_combined_text_chars = 30000,
}) {
  const ticketWrap = await safeGet(zd, `/api/v2/tickets/${ticket_id}.json`);
  const t = ticketWrap?.ticket;
  if (!t) return null;

  const userMap = await fetchUsersByIds(zd, [t.requester_id, t.submitter_id, t.assignee_id].filter(Boolean));
  const groupMap = await fetchGroupsByIds(zd, [t.group_id].filter(Boolean));

  const requester = userMap[t.requester_id] || null;
  const orgMap = await fetchOrganizationsByIds(zd, [requester?.organization_id].filter(Boolean));
  const requesterOrg = requester?.organization_id ? orgMap[requester.organization_id] || null : null;

  const base = normalizeTicketMetadata(t, userMap, groupMap);

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

  let timeline = {
    messages: [],
    public_agent_reply_count: 0,
    public_requester_message_count: 0,
    public_touch_count: 0,
    bot_message_count: 0,
  };

  if (include_comments) {
    timeline = await buildConversationTimeline({
      zd,
      ticket_id,
      requesterId: t.requester_id,
      max_text_chars_per_message,
    });
  }

  const conversation_messages = timeline.messages;
  const handling_flow = inferHandlingFlow(conversation_messages);
  const touch_classification = classifyTouchBucket(timeline.public_agent_reply_count);

  const agents_in_thread = uniq(
    conversation_messages
      .filter((m) => m.public && m.author_type === 'agent')
      .map((m) => ({
        author_id: m.author_id,
        author_name: m.author_name,
        author_email: m.author_email,
      }))
      .map((x) => JSON.stringify(x))
  ).map((x) => JSON.parse(x));

  const bots_in_thread = uniq(
    conversation_messages
      .filter((m) => m.public && m.author_type === 'bot')
      .map((m) => m.author_name || m.author_email || String(m.author_id))
  );

  return {
    ...base,

    requester_organization_name: requesterOrg?.name || null,
    requester_organization_tags: requesterOrg?.tags || [],

    resolved_at: resolved_at || t.solved_at || t.closed_at || null,
    resolution_time_hrs: resolution_time_hrs ?? null,

    csat_score: csat_score ?? null,

    first_reply_time_mins: metrics?.first_reply_time_mins ?? null,
    reply_time_mins: metrics?.reply_time_mins ?? null,
    resolution_time_mins: metrics?.resolution_time_mins ?? null,
    resolution_time_hrs_from_metrics: metrics?.resolution_time_hrs_from_metrics ?? null,

    public_agent_reply_count: timeline.public_agent_reply_count,
    public_requester_message_count: timeline.public_requester_message_count,
    public_touch_count: timeline.public_touch_count,
    bot_message_count: timeline.bot_message_count,

    touch_classification,
    handling_flow,

    agents_in_thread,
    bots_in_thread,

    conversation_messages,
    conversation_text_public_only: buildConversationText(conversation_messages, {
      publicOnly: true,
      maxCombinedChars: max_combined_text_chars,
    }),
    conversation_text_all: buildConversationText(conversation_messages, {
      publicOnly: false,
      maxCombinedChars: max_combined_text_chars,
    }),
  };
}

function createMcpServer() {
  const server = new McpServer(
    { name: 'zendesk-audit-mcp', version: '5.0.0' },
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
    'search_tickets',
    {
      description:
        'Search tickets using Zendesk Search API (metadata-only, paginated). Good for requester email, tags, status, channel, assignee, date range.',
      inputSchema: z.object({
        query: z.string().min(1),
        per_page: z.number().int().min(1).max(100).optional().default(100),
        next_page: z.string().optional().nullable(),
        max_return: z.number().int().min(1).max(1000).optional().default(300),
        include_user_fields: z.boolean().optional().default(true),
        include_group_fields: z.boolean().optional().default(true),
      }),
    },
    async ({ query, per_page, next_page, max_return, include_user_fields, include_group_fields }) => {
      const zd = zendeskClient();
      const page = await searchPage(zd, { query, per_page, pageUrl: next_page || null });
      const sliced = (page.results || []).slice(0, max_return);

      let userMap = {};
      let groupMap = {};

      if (include_user_fields) {
        userMap = await fetchUsersByIds(
          zd,
          sliced.flatMap((t) => [t.requester_id, t.submitter_id, t.assignee_id]).filter(Boolean)
        );
      }

      if (include_group_fields) {
        groupMap = await fetchGroupsByIds(zd, sliced.map((t) => t.group_id).filter(Boolean));
      }

      const tickets = sliced.map((t) => normalizeTicketMetadata(t, userMap, groupMap));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ tickets, next_page: page.next_page, count: page.count }, null, 2),
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
    'find_tickets_for_audit',
    {
      description:
        'Find candidate tickets for audit using structured filters. Returns metadata and optional filtering for minimum public agent replies.',
      inputSchema: z.object({
        requester_email: z.string().email().optional(),
        ticket_tag: z.string().optional(),
        brand_tag: z.string().optional(),
        status: z.string().optional(),
        channel: z.string().optional(),
        assignee_name: z.string().optional(),
        group_id: z.number().int().optional(),
        free_text: z.string().optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        per_page: z.number().int().min(1).max(100).optional().default(50),
        max_return: z.number().int().min(1).max(200).optional().default(50),
        min_public_agent_replies: z.number().int().min(0).max(50).optional(),
        include_counts: z.boolean().optional().default(false),
      }),
    },
    async ({
      requester_email,
      ticket_tag,
      brand_tag,
      status,
      channel,
      assignee_name,
      group_id,
      free_text,
      start_date,
      end_date,
      per_page,
      max_return,
      min_public_agent_replies,
      include_counts,
    }) => {
      const zd = zendeskClient();

      const query = buildZendeskSearchQuery({
        requester_email,
        ticket_tag,
        brand_tag,
        status,
        channel,
        assignee_name,
        group_id,
        free_text,
        start_date,
        end_date,
      });

      const page = await searchPage(zd, { query, per_page });
      const initial = (page.results || []).slice(0, max_return);

      const userMap = await fetchUsersByIds(
        zd,
        initial.flatMap((t) => [t.requester_id, t.submitter_id, t.assignee_id]).filter(Boolean)
      );
      const groupMap = await fetchGroupsByIds(zd, initial.map((t) => t.group_id).filter(Boolean));

      const candidates = [];
      for (const t of initial) {
        let replyCount = null;
        let touchBucket = null;

        if (include_counts || min_public_agent_replies != null) {
          const timeline = await buildConversationTimeline({
            zd,
            ticket_id: t.id,
            requesterId: t.requester_id,
            max_text_chars_per_message: 1000,
          });

          replyCount = timeline.public_agent_reply_count;
          touchBucket = classifyTouchBucket(replyCount);

          if (min_public_agent_replies != null && replyCount < min_public_agent_replies) {
            continue;
          }
        }

        candidates.push({
          ...normalizeTicketMetadata(t, userMap, groupMap),
          public_agent_reply_count: replyCount,
          touch_classification: touchBucket,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ query, tickets: candidates, next_page: page.next_page, count: page.count }, null, 2),
          },
        ],
        structuredContent: {
          query,
          tickets: candidates,
          next_page: page.next_page,
          count: page.count,
        },
      };
    }
  );

  server.registerTool(
    'list_tickets_since',
    {
      description:
        'List tickets since start_date using Incremental Export (metadata-only, paginated).',
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().default('2026-01-01'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        next_page: z.string().optional().nullable(),
        max_return: z.number().int().min(1).max(2000).optional().default(1000),
        channel: z.string().optional(),
        tag: z.string().optional(),
        status: z.string().optional(),
        include_user_fields: z.boolean().optional().default(true),
        include_group_fields: z.boolean().optional().default(true),
      }),
    },
    async ({ start_date, end_date, next_page, max_return, channel, tag, status, include_user_fields, include_group_fields }) => {
      const zd = zendeskClient();

      const startUnix = Math.floor(new Date(`${start_date}T00:00:00Z`).getTime() / 1000);
      if (!Number.isFinite(startUnix) || startUnix <= 0) {
        throw new Error('Invalid start_date. Use YYYY-MM-DD.');
      }

      const endMs = end_date ? new Date(`${end_date}T23:59:59Z`).getTime() : null;
      const page = await incrementalTicketsPage(zd, { start_time_unix: startUnix, pageUrl: next_page || null });

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

      let userMap = {};
      let groupMap = {};

      if (include_user_fields) {
        userMap = await fetchUsersByIds(
          zd,
          filtered.flatMap((t) => [t.requester_id, t.submitter_id, t.assignee_id]).filter(Boolean)
        );
      }

      if (include_group_fields) {
        groupMap = await fetchGroupsByIds(zd, filtered.map((t) => t.group_id).filter(Boolean));
      }

      const tickets = filtered.map((t) => normalizeTicketMetadata(t, userMap, groupMap));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { tickets, next_page: page.next_page, end_of_stream: page.end_of_stream },
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

  server.registerTool(
    'get_ticket',
    {
      description:
        'Get one ticket with full structured conversation, requester tags, CSAT, and metrics.',
      inputSchema: z.object({
        ticket_id: z.number().int(),
        include_comments: z.boolean().optional().default(true),
        include_csat: z.boolean().optional().default(true),
        include_metrics: z.boolean().optional().default(true),
        include_resolved_audits: z.boolean().optional().default(false),
        max_text_chars_per_message: z.number().int().min(200).max(10000).optional().default(4000),
        max_combined_text_chars: z.number().int().min(1000).max(100000).optional().default(30000),
      }),
    },
    async ({
      ticket_id,
      include_comments,
      include_csat,
      include_metrics,
      include_resolved_audits,
      max_text_chars_per_message,
      max_combined_text_chars,
    }) => {
      const zd = zendeskClient();

      const detailed = await getTicketAuditPayload({
        zd,
        ticket_id,
        include_comments,
        include_csat,
        include_metrics,
        include_resolved_audits,
        max_text_chars_per_message,
        max_combined_text_chars,
      });

      if (!detailed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found' }) }],
          structuredContent: { error: 'Ticket not found' },
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(detailed, null, 2) }],
        structuredContent: detailed,
      };
    }
  );

  server.registerTool(
    'get_ticket_audit_payload',
    {
      description:
        'Get an audit-friendly payload for one ticket, including structured messages, touch counts, agents in thread, requester tags, CSAT, and metrics.',
      inputSchema: z.object({
        ticket_id: z.number().int(),
        include_csat: z.boolean().optional().default(true),
        include_metrics: z.boolean().optional().default(true),
        include_resolved_audits: z.boolean().optional().default(false),
        max_text_chars_per_message: z.number().int().min(200).max(10000).optional().default(4000),
        max_combined_text_chars: z.number().int().min(1000).max(100000).optional().default(30000),
      }),
    },
    async ({
      ticket_id,
      include_csat,
      include_metrics,
      include_resolved_audits,
      max_text_chars_per_message,
      max_combined_text_chars,
    }) => {
      const zd = zendeskClient();

      const detailed = await getTicketAuditPayload({
        zd,
        ticket_id,
        include_comments: true,
        include_csat,
        include_metrics,
        include_resolved_audits,
        max_text_chars_per_message,
        max_combined_text_chars,
      });

      if (!detailed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found' }) }],
          structuredContent: { error: 'Ticket not found' },
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(detailed, null, 2) }],
        structuredContent: detailed,
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
app.use(express.json({ limit: '4mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'zendesk-audit-mcp',
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

app.listen(PORT, () => {
  console.log(`Zendesk Audit MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Shared secret gate: ${MCP_SHARED_SECRET ? 'ENABLED' : 'DISABLED'}`);
});
