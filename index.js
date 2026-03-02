require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.MCP_API_KEY;

const zendesk = axios.create({
  baseURL: `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com`,
  auth: {
    username: `${process.env.ZENDESK_EMAIL}/token`,
    password: process.env.ZENDESK_API_TOKEN,
  },
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Simple API key middleware
function checkKey(req, res, next) {
  if (req.headers["x-mcp-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Get ticket (read-only)
app.post("/tools/get_ticket", checkKey, async (req, res) => {
  const { ticket_id } = req.body;

  try {
    const response = await zendesk.get(`/api/v2/tickets/${ticket_id}.json`);
    const ticket = response.data.ticket;

    res.json({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      description: ticket.description,
      url: `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${ticket.id}`
    });
  } catch (err) {
    res.status(500).json({ error: "Zendesk request failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
