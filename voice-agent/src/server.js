const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod"); // fix: destructure z from zod

// ============================================================
// IN-MEMORY USER STORE
// Stores caller history by phone number.
// In production this would be a database like PostgreSQL.
// Structure: { "+15551234567": { lastMeal, callCount, preferences[] } }
// ============================================================
const userStore = {};

// ============================================================
// MEAL DATA + SUGGESTION LOGIC
// Each meal has a list of key ingredients.
// suggestMeal() scores every meal by how many of the caller's
// ingredients match, and returns the best match.
// ============================================================
const MEALS = [
  {
    name: "Garlic Chicken Stir Fry",
    ingredients: ["chicken", "garlic", "soy sauce", "vegetables", "oil", "rice"],
    instructions:
      "Slice chicken and mince garlic. Heat oil in a pan, cook chicken through. Add garlic and any vegetables, stir-fry 2-3 minutes. Add soy sauce, toss together and serve over rice.",
  },
  {
    name: "Spinach and Egg Scramble",
    ingredients: ["spinach", "eggs", "butter", "salt", "pepper"],
    instructions:
      "Melt butter in a pan, add spinach and wilt for one minute. Beat eggs with salt and pepper, pour over spinach and scramble on medium heat until just set.",
  },
  {
    name: "Rice Bowl",
    ingredients: ["rice", "vegetables", "soy sauce", "egg", "oil"],
    instructions:
      "Cook rice. Fry an egg and set aside. Saute any vegetables in oil, add cooked rice and a splash of soy sauce. Top with the fried egg.",
  },
  {
    name: "Simple Pasta",
    ingredients: ["pasta", "tomato", "garlic", "olive oil", "basil", "salt"],
    instructions:
      "Boil pasta until al dente. Saute garlic in olive oil, add chopped tomato and cook down 5 minutes. Toss with drained pasta, top with fresh basil.",
  },
  {
    name: "Veggie Soup",
    ingredients: ["vegetables", "broth", "onion", "garlic", "salt", "pepper"],
    instructions:
      "Saute chopped onion and garlic until soft. Add broth and any chopped vegetables. Simmer 20 minutes until tender. Season with salt and pepper.",
  },
];

function suggestMeal(ingredients) {
  const callerIngredients = ingredients.map((i) => String(i).toLowerCase());

  let bestMatch = { score: -1, meal: MEALS[0] };

  for (const meal of MEALS) {
    const score = callerIngredients.filter((callerIng) =>
      meal.ingredients.some(
        (mealIng) => mealIng.includes(callerIng) || callerIng.includes(mealIng)
      )
    ).length;

    if (score > bestMatch.score) {
      bestMatch = { score, meal };
    }
  }

  return { name: bestMatch.meal.name, instructions: bestMatch.meal.instructions };
}

// ============================================================
// MCP SERVER
// Exposes 3 tools that the Telnyx AI can call mid-conversation.
// A new server instance is created per request (stateless).
// ============================================================
function buildMcpServer() {
  const server = new McpServer({ name: "fridge-to-meal", version: "1.0.0" });

  // Tool 1: Look up a caller's history
  server.tool(
    "get_user_history",
    "Get the meal history and preferences for a caller by their phone number",
    { phone: z.string().describe("Caller phone number") },
    async ({ phone }) => {
      const user = userStore[phone] || {
        lastMeal: "nothing yet",
        callCount: 0,
        preferences: [],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(user, null, 2) }],
      };
    }
  );

  // Tool 2: Suggest a meal from a list of ingredients
  server.tool(
    "suggest_meal",
    "Suggest the best meal based on available ingredients. Pass phone number to get a personalized tip.",
    {
      ingredients: z.array(z.string()).describe("Ingredients the caller has available"),
      phone: z.string().optional().describe("Caller phone number for personalization"),
    },
    async ({ ingredients, phone }) => {
      const meal = suggestMeal(ingredients);

      // Personalized tip if this is a returning caller
      let tip = "";
      if (phone && userStore[phone]?.lastMeal) {
        tip = `Last time you made ${userStore[phone].lastMeal} — this is something different!`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { meal_name: meal.name, instructions: meal.instructions, tip: tip || undefined },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 3: Save what the caller made and whether they liked it
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

      if (liked) {
        userStore[phone].preferences.push(meal_name);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ saved: true, ...userStore[phone] }),
          },
        ],
      };
    }
  );

  return server;
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
app.use(express.json());

// Health check — confirms the server is running
app.get("/", (req, res) => {
  res.json({ status: "fridge-to-meal is running" });
});

// ============================================================
// DYNAMIC WEBHOOK VARIABLES ENDPOINT
// Telnyx calls this before every conversation starts.
// We return caller context so the AI can personalize the call
// using {{last_meal}} and {{greeting_type}} in the system prompt.
// ============================================================
app.post("/webhook", (req, res) => {
  const callerPhone = req.body?.from || req.body?.caller_id || "";
  const user = userStore[callerPhone];

  console.log(`[webhook] incoming call from ${callerPhone}`);

  res.json({
    caller_phone: callerPhone,
    has_history: !!user && user.callCount > 0,
    last_meal: user?.lastMeal || "nothing yet",
    call_count: user?.callCount || 0,
    favorite_meal: user?.preferences?.slice(-1)[0] || "not set yet",
    greeting_type: user?.callCount > 0 ? "returning" : "new",
  });
});

// ============================================================
// MCP TOOL DISCOVERY ENDPOINT (GET)
// Telnyx checks this to see what tools are available.
// Returns a static list matching the tools registered above.
// ============================================================
app.get("/mcp", (req, res) => {
  res.json({
    tools: [
      {
        name: "get_user_history",
        description: "Get the meal history and preferences for a caller by their phone number",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string", description: "Caller phone number" },
          },
          required: ["phone"],
        },
      },
      {
        name: "suggest_meal",
        description: "Suggest the best meal based on available ingredients",
        inputSchema: {
          type: "object",
          properties: {
            ingredients: {
              type: "array",
              items: { type: "string" },
              description: "Ingredients the caller has available",
            },
            phone: { type: "string", description: "Caller phone number for personalization" },
          },
          required: ["ingredients"],
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

// ============================================================
// MCP TOOL CALL ENDPOINT (POST)
// Telnyx sends tool calls here during the conversation.
// Each request gets a fresh server + transport (stateless).
// ============================================================
app.post("/mcp", async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  } finally {
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close();
    });
  }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`fridge-to-meal server listening on port ${PORT}`);
});