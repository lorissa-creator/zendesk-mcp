  // Read-only: list tickets created in the last N days (default 7)
  server.registerTool(
    'list_tickets',
    {
      description: 'List Zendesk tickets created in the last N days (read-only)',
      inputSchema: z.object({
        days: z.number().int().min(1).max(30).optional().default(7),
        per_page: z.number().int().min(1).max(100).optional().default(50),
      }),
    },
    async ({ days, per_page }) => {
      const zd = zendeskClient();

      // Zendesk Search uses a query string. We’ll fetch "ticket" type created within N days.
      // Example query: type:ticket created>2026-03-01
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const yyyy = since.getUTCFullYear();
      const mm = String(since.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(since.getUTCDate()).padStart(2, '0');
      const sinceStr = `${yyyy}-${mm}-${dd}`;

      const query = `type:ticket created>${sinceStr}`;

      const { data } = await zd.get('/api/v2/search.json', {
        params: { query, per_page, sort_by: 'created_at', sort_order: 'desc' },
      });

      const tickets = (data.results || []).map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        created_at: t.created_at,
        updated_at: t.updated_at,
        tags: t.tags,
        url: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${t.id}`,
        // keep description short to reduce PII + payload size
        description_snippet: (t.description || '').slice(0, 400),
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ tickets }, null, 2) }],
        structuredContent: { tickets },
      };
    }
  );
