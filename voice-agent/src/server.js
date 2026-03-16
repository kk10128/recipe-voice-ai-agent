const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// --- In-memory user store
// phone -> { callCount, lastMeal, preferences: { dietary, wantLowCarb, wantHighProtein }, likedMeals[] }
const userStore = {};

// --- Express app
const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "fridge-to-meal is running" });
});

// ============================================================
// DYNAMIC WEBHOOK VARIABLES
// Telnyx calls this before every conversation.
// Injects caller context into the system prompt.
// ============================================================
app.post("/webhook", (req, res) => {
  const callerPhone = req.body?.from || req.body?.caller_id || "";
  const user = userStore[callerPhone];

  console.log(`[webhook] call from ${callerPhone}`);

  const preferences = user?.preferences || {};

  res.json({
    caller_phone: callerPhone,
    greeting_type: user?.callCount > 0 ? "returning" : "new",
    last_meal: user?.lastMeal || "nothing yet",
    call_count: user?.callCount || 0,
    dietary_restrictions: preferences.dietary || "none",
    low_carb: preferences.wantLowCarb ? "yes" : "no",
    high_protein: preferences.wantHighProtein ? "yes" : "no",
    liked_meals: user?.likedMeals?.join(", ") || "none yet",
  });
});

// ============================================================
// MCP SERVER
// ============================================================
function getMcpServer() {
  const server = new McpServer({ name: "fridge-to-meal", version: "1.0.0" });

  // Tool 1: Get user history and dietary preferences
  server.tool(
    "get_user_history",
    "Get the full history and dietary preferences for a caller",
    { phone: z.string().describe("Caller phone number") },
    async ({ phone }) => {
      const user = userStore[phone] || {
        callCount: 0,
        lastMeal: "nothing yet",
        preferences: {},
        likedMeals: [],
      };
      return { content: [{ type: "text", text: JSON.stringify(user, null, 2) }] };
    }
  );

  // Tool 2: Search recipes by ingredients via Spoonacular API
  server.tool(
    "search_recipes",
    "Search for real recipes based on ingredients the caller has. Returns 3 options by name.",
    {
      ingredients: z.array(z.string()).describe("Ingredients the caller has"),
      phone: z.string().optional().describe("Caller phone number to apply dietary filters"),
    },
    async ({ ingredients, phone }) => {
      const user = phone ? userStore[phone] : null;
      const dietary = user?.preferences?.dietary || "";
      const lowCarb = user?.preferences?.wantLowCarb || false;
      const highProtein = user?.preferences?.wantHighProtein || false;

      // Build diet param for Spoonacular
      let dietParam = "";
      if (dietary === "vegetarian") dietParam = "&diet=vegetarian";
      else if (dietary === "vegan") dietParam = "&diet=vegan";
      else if (dietary === "gluten-free") dietParam = "&diet=gluten+free";
      else if (lowCarb) dietParam = "&diet=low-carb";

      const url = `https://api.spoonacular.com/recipes/findByIngredients?ingredients=${ingredients.join(",")}&number=3&ranking=1&ignorePantry=true${dietParam}&apiKey=${process.env.SPOONACULAR_API_KEY}`;

      const response = await fetch(url);
      const recipes = await response.json();

      if (!recipes || recipes.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No recipes found" }) }] };
      }

      const options = recipes.map((r, i) => ({
        number: i + 1,
        id: r.id,
        name: r.title,
        usedIngredients: r.usedIngredients?.map((i) => i.name).join(", "),
        missedIngredients: r.missedIngredients?.map((i) => i.name).join(", "),
      }));

      console.log(`[search_recipes] found ${options.length} recipes for ${ingredients.join(", ")}`);
      return { content: [{ type: "text", text: JSON.stringify(options, null, 2) }] };
    }
  );

  // Tool 3: Get full recipe details by Spoonacular recipe ID
  server.tool(
    "get_recipe_details",
    "Get the full recipe instructions and nutrition info for a recipe the caller picked",
    { recipe_id: z.number().describe("Spoonacular recipe ID from search_recipes results") },
    async ({ recipe_id }) => {
      const url = `https://api.spoonacular.com/recipes/${recipe_id}/information?includeNutrition=true&apiKey=${process.env.SPOONACULAR_API_KEY}`;

      const response = await fetch(url);
      const recipe = await response.json();

      const steps = recipe.analyzedInstructions?.[0]?.steps?.map((s) => s.step).join(" ") || recipe.instructions || "No instructions available";

      const nutrition = recipe.nutrition?.nutrients?.filter((n) =>
        ["Calories", "Protein", "Carbohydrates", "Fat"].includes(n.name)
      ).map((n) => `${n.name}: ${Math.round(n.amount)}${n.unit}`).join(", ") || "Nutrition info unavailable";

      const details = {
        name: recipe.title,
        servings: recipe.servings,
        cookTime: `${recipe.readyInMinutes} minutes`,
        nutrition,
        instructions: steps,
        sourceUrl: recipe.sourceUrl || "",
      };

      console.log(`[get_recipe_details] fetched details for recipe ${recipe_id}`);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
    }
  );

  // Tool 4: Text the recipe to the caller via Telnyx SMS
  server.tool(
    "send_recipe_sms",
    "Text the full recipe instructions to the caller's phone number",
    {
      phone: z.string().describe("Caller phone number to text"),
      recipe_name: z.string().describe("Name of the recipe"),
      instructions: z.string().describe("Recipe instructions to send"),
      cook_time: z.string().optional().describe("How long it takes to cook"),
    },
    async ({ phone, recipe_name, instructions, cook_time }) => {
      const message = `🍳 ${recipe_name}${cook_time ? ` (${cook_time})` : ""}\n\n${instructions}\n\n— Fridge Friend`;

      const response = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.TELNYX_API_KEY}`,
        },
        body: JSON.stringify({
          from: process.env.TELNYX_PHONE_NUMBER,
          to: phone,
          text: message,
        }),
      });

      const data = await response.json();
      const success = response.ok;

      console.log(`[send_recipe_sms] SMS to ${phone}: ${success ? "sent" : "failed"}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ sent: success, to: phone }) }],
      };
    }
  );

  // Tool 5: Save preferences and what the caller made
  server.tool(
    "save_preference",
    "Save the caller's meal choice, whether they liked it, and any dietary preferences they mentioned",
    {
      phone: z.string().describe("Caller phone number"),
      meal_name: z.string().describe("Name of the meal they chose"),
      liked: z.boolean().describe("Whether the caller liked the meal"),
      dietary: z.string().optional().describe("Any dietary restriction mentioned: vegetarian, vegan, gluten-free, or none"),
      low_carb: z.boolean().optional().describe("Whether the caller wants low carb meals"),
      high_protein: z.boolean().optional().describe("Whether the caller wants high protein meals"),
    },
    async ({ phone, meal_name, liked, dietary, low_carb, high_protein }) => {
      if (!userStore[phone]) {
        userStore[phone] = { callCount: 0, lastMeal: "", preferences: {}, likedMeals: [] };
      }

      const user = userStore[phone];
      user.lastMeal = meal_name;
      user.callCount += 1;
      if (liked) user.likedMeals.push(meal_name);
      if (dietary) user.preferences.dietary = dietary;
      if (low_carb !== undefined) user.preferences.wantLowCarb = low_carb;
      if (high_protein !== undefined) user.preferences.wantHighProtein = high_protein;

      console.log(`[save_preference] updated ${phone}: ${meal_name}, liked: ${liked}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ saved: true, ...user }) }],
      };
    }
  );

  return server;
}

// --- MCP tool discovery (GET)
app.get("/mcp", (req, res) => {
  res.json({
    tools: [
      {
        name: "get_user_history",
        description: "Get the full history and dietary preferences for a caller",
        inputSchema: {
          type: "object",
          properties: { phone: { type: "string" } },
          required: ["phone"],
        },
      },
      {
        name: "search_recipes",
        description: "Search for real recipes based on ingredients the caller has",
        inputSchema: {
          type: "object",
          properties: {
            ingredients: { type: "array", items: { type: "string" } },
            phone: { type: "string" },
          },
          required: ["ingredients"],
        },
      },
      {
        name: "get_recipe_details",
        description: "Get full recipe instructions and nutrition for a recipe the caller picked",
        inputSchema: {
          type: "object",
          properties: { recipe_id: { type: "number" } },
          required: ["recipe_id"],
        },
      },
      {
        name: "send_recipe_sms",
        description: "Text the recipe to the caller's phone number",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string" },
            recipe_name: { type: "string" },
            instructions: { type: "string" },
            cook_time: { type: "string" },
          },
          required: ["phone", "recipe_name", "instructions"],
        },
      },
      {
        name: "save_preference",
        description: "Save the caller's meal choice and dietary preferences",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string" },
            meal_name: { type: "string" },
            liked: { type: "boolean" },
            dietary: { type: "string" },
            low_carb: { type: "boolean" },
            high_protein: { type: "boolean" },
          },
          required: ["phone", "meal_name", "liked"],
        },
      },
    ],
  });
});

// --- MCP tool calls (POST)
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