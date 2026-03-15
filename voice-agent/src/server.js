const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const z = require("zod");

// --- In-memory user store: phone -> { lastMeal, callCount, preferences[] }
const userStore = Object.create(null);

// --- Hardcoded meals with ingredients and instructions
const MEALS = [
  {
    name: "Garlic Chicken Stir Fry",
    ingredients: ["chicken", "garlic", "soy sauce", "vegetables", "oil", "rice"],
    instructions: "Slice chicken, mince garlic. Heat oil in a wok, stir-fry chicken until cooked. Add garlic and vegetables, stir-fry 2–3 minutes. Add soy sauce, toss and serve over rice.",
  },
  {
    name: "Spinach and Egg Scramble",
    ingredients: ["spinach", "eggs", "butter", "salt", "pepper"],
    instructions: "Wilt spinach in a pan with a little butter. Beat eggs with salt and pepper, pour over spinach. Scramble over medium heat until set. Serve immediately.",
  },
  {
    name: "Rice Bowl",
    ingredients: ["rice", "vegetables", "soy sauce", "egg", "oil"],
    instructions: "Cook rice. Fry an egg and set aside. Sauté vegetables in oil, add cooked rice and soy sauce. Top with the fried egg.",
  },
  {
    name: "Pasta",
    ingredients: ["pasta", "tomato", "garlic", "olive oil", "basil", "salt"],
    instructions: "Boil pasta until al dente. Sauté garlic in olive oil, add chopped tomato and basil. Toss with drained pasta and salt.",
  },
  {
    name: "Veggie Soup",
    ingredients: ["vegetables", "broth", "onion", "garlic", "salt", "pepper"],
    instructions: "Sauté chopped onion and garlic. Add broth and chopped vegetables, simmer until tender. Season with salt and pepper.",
  },
];

function suggestMeal(ingredients) {
  const list = Array.isArray(ingredients) ? ingredients.map((i) => String(i).toLowerCase()) : [];
  let best = { score: -1, meal: MEALS[0] };
  for (const meal of MEALS) {
    const mealIngreds = meal.ingredients.map((i) => i.toLowerCase());
    const score = list.filter((i) => mealIngreds.some((m) => m.includes(i) || i.includes(m))).length;
    if (score > best.score) best = { score, meal };
  }
  return { name: best.meal.name, instructions: best.meal.instructions };
}

// --- Express app
const app = express();
app.use(express.json());

// GET / health check
app.get("/", (req, res) => {
  res.json({ status: "fridge-to-meal is running" });
});

app.get("/mcp", async (req, res) => {
  const server = getMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP GET error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP server error" });
    }
  }
});

// POST /webhook
app.post("/webhook", (req, res) => {
  const from = req.body && req.body.from;
  const user = from ? userStore[String(from)] : undefined;
  const callCount = user ? user.callCount : 0;
  const lastMeal = user && user.lastMeal ? user.lastMeal : "nothing yet";
  const favoriteMeal =
    user && user.preferences && user.preferences.length > 0
      ? user.preferences[user.preferences.length - 1]
      : "not set yet";
  res.json({
    caller_phone: from || "",
    has_history: !!user && callCount > 0,
    last_meal: lastMeal,
    call_count: callCount,
    favorite_meal: favoriteMeal,
    greeting_type: callCount > 0 ? "returning" : "new",
  });
});

// --- MCP server with 3 tools
function getMcpServer() {
  const server = new McpServer({
    name: "fridge-to-meal",
    version: "1.0.0",
  });

  server.registerTool(
    "get_user_history",
    {
      description: "Get user data from the store by phone number",
      inputSchema: {
        phone: z.string().describe("User phone number"),
      },
    },
    async ({ phone }) => {
      const user = userStore[String(phone)];
      const data = user
        ? {
            lastMeal: user.lastMeal || "nothing yet",
            callCount: user.callCount || 0,
            preferences: user.preferences || [],
          }
        : { lastMeal: "nothing yet", callCount: 0, preferences: [] };
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "suggest_meal",
    {
      description: "Suggest a meal based on ingredients; optionally include a tip referencing the user's last meal if phone is provided and they have history",
      inputSchema: {
        ingredients: z.array(z.string()).describe("List of ingredients"),
        phone: z.string().optional().describe("Optional user phone for personalized tip"),
      },
    },
    async ({ ingredients, phone }) => {
      const result = suggestMeal(ingredients);
      let tip = "";
      if (phone) {
        const user = userStore[String(phone)];
        if (user && user.lastMeal) {
          tip = ` Since you had ${user.lastMeal} last time, this is a nice change of pace.`;
        }
      }
      const text = `Meal: ${result.name}\n\nInstructions: ${result.instructions}${tip ? "\n\nTip:" + tip : ""}`;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ meal_name: result.name, instructions: result.instructions, tip: tip || undefined }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "save_preference",
    {
      description: "Update user with last meal, increment call count, and optionally add meal to preferences if liked",
      inputSchema: {
        phone: z.string().describe("User phone number"),
        meal_name: z.string().describe("Name of the meal"),
        liked: z.boolean().describe("Whether the user liked the meal"),
      },
    },
    async ({ phone, meal_name, liked }) => {
      const key = String(phone);
      if (!userStore[key]) {
        userStore[key] = { lastMeal: "", callCount: 0, preferences: [] };
      }
      const user = userStore[key];
      user.lastMeal = meal_name;
      user.callCount = (user.callCount || 0) + 1;
      if (liked) {
        user.preferences = user.preferences || [];
        user.preferences.push(meal_name);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              lastMeal: user.lastMeal,
              callCount: user.callCount,
              preferences: user.preferences,
            }),
          },
        ],
      };
    }
  );

  return server;
}

// POST /mcp — handle MCP requests with StreamableHTTPServerTransport
app.post("/mcp", async (req, res) => {
  const server = getMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
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

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`fridge-to-meal server listening on port ${PORT}`);
});
