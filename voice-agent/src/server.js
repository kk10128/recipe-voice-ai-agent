const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// --- In-memory user store: phone -> { lastMeal, callCount, preferences[] }
// In production this would be a real database like PostgreSQL
const userStore = {};

// --- Express app
const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "fridge-to-meal is running" });
});

// --- Dynamic Webhook Variables endpoint
// Telnyx calls this before every conversation starts.
// Returns caller context injected into the system prompt as {{last_meal}}, {{greeting_type}} etc.
app.post("/webhook", (req, res) => {
  const callerPhone = req.body?.from || req.body?.caller_id || "";
  const user = userStore[callerPhone];

  console.log(`[webhook] call from ${callerPhone}`);

  res.json({
    caller_phone: callerPhone,
    has_history: !!user && user.callCount > 0,
    last_meal: user?.lastMeal || "nothing yet",
    call_count: user?.callCount || 0,
    favorite_meal: user?.preferences?.slice(-1)[0] || "not set yet",
    greeting_type: user?.callCount > 0 ? "returning" : "new",
  });
});

// --- MCP server
// Exposes 2 tools the Telnyx AI calls mid-conversation.
// The AI handles meal suggestions itself — MCP is only used to read/write user data.
function getMcpServer() {
  const server = new McpServer({ name: "fridge-to-meal", version: "1.0.0" });

  // Tool 1: Look up a caller's history
  server.tool(
    "get_user_history",
    "Get the meal history and preferences for a caller by their phone number",
    { phone: z.string().describe("Caller phone number") },
    async ({ phone }) => {
      const user = userStore[phone] || { lastMeal: "nothing yet", callCount: 0, preferences: [] };
      return { content: [{ type: "text", text: JSON.stringify(user, null, 2) }] };
    }
  );

  // Tool 2: Save what the caller made and whether they liked it
  server.tool(
    "save_preference",
    "Save the meal a caller made and whether they liked it. Updates their history for future calls.",
    {
      phone: z.string().describe("Caller phone number"),
      meal_name: z.string().describe("Name of the meal they made"),
      liked: z.boolean().describe("Whether the caller liked the meal"),
    },
    async ({ phone, meal_name, liked }) => {
      if (!userStore[phone]) {
        userStore[phone] = { lastMeal: "", callCount: 0, preferences: [] };
      }
      userStore[phone].lastMeal = meal_name;
      userStore[phone].callCount += 1;
      if (liked) userStore[phone].preferences.push(meal_name);

      console.log(`[save_preference] saved ${meal_name} for ${phone}, liked: ${liked}`);

      return {
        content: [{ type: "text", text: JSON.stringify({ saved: true, ...userStore[phone] }) }],
      };
    }
  );

  return server;
}

// --- MCP tool discovery (GET)
// Telnyx hits this first to see what tools are available.
app.get("/mcp", (req, res) => {
  res.json({
    tools: [
      {
        name: "get_user_history",
        description: "Get the meal history and preferences for a caller by their phone number",
        inputSchema: {
          type: "object",
          properties: { phone: { type: "string", description: "Caller phone number" } },
          required: ["phone"],
        },
      },
      {
        name: "save_preference",
        description: "Save the meal a caller made and whether they liked it",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string", description: "Caller phone number" },
            meal_name: { type: "string", description: "Name of the meal they made" },
            liked: { type: "boolean", description: "Whether the caller liked the meal" },
          },
          required: ["phone", "meal_name", "liked"],
        },
      },
    ],
  });
});

// --- MCP tool calls (POST)
// Telnyx sends actual tool calls here mid-conversation.
app.post("/mcp", async (req, res) => {
  const server = getMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  } finally {
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close();
    });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`fridge-to-meal server listening on port ${PORT}`));