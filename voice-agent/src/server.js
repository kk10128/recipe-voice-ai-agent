const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// --- In-memory user store
// phone -> { callCount, lastMeal, preferences: { dietary, wantLowCarb, wantHighProtein }, likedMeals[] }
// In production this would be a real database like PostgreSQL
const userStore = {};
// Fallback for tool calls that arrive without a real phone number.
// This relies on the assumption of one active call flow at a time.
let lastWebhookCallerPhone = "";

// --- Express app
const app = express();
app.use(express.json());

function normalizePhone(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // If templating didn't run, we might get literal placeholders.
  if (trimmed.includes("{{") && trimmed.includes("}}")) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined") return "";

  // Keep a leading "+" if present; strip everything else.
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return hasPlus ? `+${digits}` : digits;
}

function extractPhoneFromRequest(req) {
  const body = req?.body || {};
  const headers = req?.headers || {};

  const candidates = [
    body.from,
    body.caller_id,
    body.callerPhone,
    body.caller_phone,
    body.phone,
    body.from_number,
    body.fromNumber,
    // Common Telnyx-ish nesting shapes
    body?.data?.from,
    body?.data?.caller_id,
    body?.data?.payload?.from,
    body?.data?.payload?.caller_id,
    body?.data?.payload?.from_number,
    body?.data?.payload?.fromNumber,
    body?.payload?.from,
    body?.payload?.caller_id,
    body?.payload?.from_number,
    body?.payload?.fromNumber,
    // Common headers (best-effort)
    headers["x-from"],
    headers["x-caller-phone"],
    headers["x-telnyx-from"],
    headers["x-telnyx-caller-phone"],
  ];

  for (const c of candidates) {
    const p = normalizePhone(c);
    if (p) return p;
  }
  return "";
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "fridge-to-meal is running" });
});

// ============================================================
// DYNAMIC WEBHOOK VARIABLES
// Telnyx calls this before every conversation starts.
// Returns caller context injected into the system prompt as
// {{greeting_type}}, {{last_meal}}, {{dietary_restrictions}} etc.
// ============================================================
app.post("/webhook", (req, res) => {
  const callerPhone = extractPhoneFromRequest(req);
  const existingUser = callerPhone ? userStore[callerPhone] : undefined;
  const isReturning = !!(existingUser && existingUser.callCount > 0);

  // Increment call count at call start so "returning" greeting works even
  // if the caller doesn't accept SMS (which is when save_preference runs).
  if (callerPhone) {
    if (!userStore[callerPhone]) {
      userStore[callerPhone] = { callCount: 0, lastMeal: "nothing yet", preferences: {}, likedMeals: [] };
    }
    userStore[callerPhone].callCount += 1;
  }

  const user = callerPhone ? userStore[callerPhone] : undefined;

  console.log(`[webhook] call from ${callerPhone}`);
  if (callerPhone) lastWebhookCallerPhone = callerPhone;

  const preferences = user?.preferences || {};

  res.json({
    caller_phone: callerPhone,
    greeting_type: isReturning ? "returning" : "new",
    last_meal: user?.lastMeal || "nothing yet",
    call_count: user?.callCount || 0,
    dietary_restrictions: preferences.dietary || "none",
    low_carb: preferences.wantLowCarb ? "yes" : "no",
    high_protein: preferences.wantHighProtein ? "yes" : "no",
    liked_meals: user?.likedMeals?.join(", ") || "none yet",
  });
});

// ============================================================
// TOOL HANDLERS
// These are the actual functions each tool runs.
// Shared between the direct /tools/ endpoints and the MCP server.
// ============================================================

async function handleGetUserHistory({ phone }) {
  const normalized = normalizePhone(phone);
  console.log(`[tool] get_user_history for ${normalized || phone}`);
  const user = normalized ? userStore[normalized] : null;
  return (
    user || {
    callCount: 0,
    lastMeal: "nothing yet",
    preferences: {},
    likedMeals: [],
    }
  );
}

async function handleSearchRecipes({ ingredients, phone }) {
  const normalized = normalizePhone(phone);
  console.log(`[tool] search_recipes for ${ingredients}`);
  const user = normalized ? userStore[normalized] : null;
  const dietary = user?.preferences?.dietary || "";
  const lowCarb = user?.preferences?.wantLowCarb || false;

  let dietParam = "";
  if (dietary === "vegetarian") dietParam = "&diet=vegetarian";
  else if (dietary === "vegan") dietParam = "&diet=vegan";
  else if (dietary === "gluten-free") dietParam = "&diet=gluten+free";
  else if (lowCarb) dietParam = "&diet=low-carb";

  const url = `https://api.spoonacular.com/recipes/findByIngredients?ingredients=${ingredients.join(",")}&number=5&ranking=2&ignorePantry=true${dietParam}&apiKey=${process.env.SPOONACULAR_API_KEY}`;

  const response = await fetch(url);
  const recipes = await response.json();

  if (!recipes || recipes.length === 0) {
    return { error: "No recipes found" };
  }

  const filtered = recipes.filter((r) => r.missedIngredientCount === 0);
  const finalRecipes = (filtered.length > 0 ? filtered : recipes).slice(0, 3);

  return finalRecipes.map((r, i) => ({
    number: i + 1,
    id: r.id,
    name: r.title,
    usedIngredients: r.usedIngredients?.map((i) => i.name).join(", "),
    missedIngredients: r.missedIngredients?.map((i) => i.name).join(", ") || "none",
    missedCount: r.missedIngredientCount,
  }));
}

async function handleGetRecipeDetails({ recipe_id }) {
  console.log(`[tool] get_recipe_details for ${recipe_id}`);
  const url = `https://api.spoonacular.com/recipes/${recipe_id}/information?includeNutrition=true&apiKey=${process.env.SPOONACULAR_API_KEY}`;

  const response = await fetch(url);
  const recipe = await response.json();

  const steps =
    recipe.analyzedInstructions?.[0]?.steps?.map((s) => s.step).join(" ") ||
    recipe.instructions ||
    "No instructions available";

  const nutrition =
    recipe.nutrition?.nutrients
      ?.filter((n) => ["Calories", "Protein", "Carbohydrates", "Fat"].includes(n.name))
      .map((n) => `${n.name}: ${Math.round(n.amount)}${n.unit}`)
      .join(", ") || "Nutrition info unavailable";

  return {
    name: recipe.title,
    servings: recipe.servings,
    cookTime: `${recipe.readyInMinutes} minutes`,
    nutrition,
    instructions: steps,
  };
}

async function handleSendRecipeSms({ phone, recipe_name, instructions, cook_time }) {
  const normalized = normalizePhone(phone);
  console.log(`[tool] send_recipe_sms to ${normalized || phone}`);
  const target = normalized || lastWebhookCallerPhone;
  if (!target) {
    return { sent: false, error: "missing_phone" };
  }
  const message = `🍳 ${recipe_name}${cook_time ? ` (${cook_time})` : ""}\n\n${instructions}\n\n— Fridge Friend`;

  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify({
      from: process.env.TELNYX_PHONE_NUMBER,
      to: target,
      text: message,
    }),
  });

  const success = response.ok;
  console.log(`[tool] SMS to ${phone}: ${success ? "sent" : "failed"}`);
  return { sent: success, to: phone };
}

async function handleSavePreference({ phone, meal_name, liked, dietary, low_carb, high_protein }) {
  const normalized = normalizePhone(phone);
  console.log(`[tool] save_preference for ${normalized || phone}: ${meal_name}`);
  const target = normalized || lastWebhookCallerPhone;
  if (!target) {
    return { saved: false, error: "missing_phone" };
  }

  if (!userStore[target]) {
    userStore[target] = { callCount: 0, lastMeal: "", preferences: {}, likedMeals: [] };
  }

  const user = userStore[target];
  user.lastMeal = meal_name;
  user.callCount += 1;
  if (liked) user.likedMeals.push(meal_name);
  if (dietary) user.preferences.dietary = dietary;
  if (low_carb !== undefined) user.preferences.wantLowCarb = low_carb;
  if (high_protein !== undefined) user.preferences.wantHighProtein = high_protein;

  return { saved: true, ...user };
}

// ============================================================
// DIRECT TOOL ENDPOINTS
// Telnyx webhook tools POST here with plain JSON.
// Each endpoint calls the shared handler above.
// ============================================================

app.post("/tools/get_user_history", async (req, res) => {
  try {
    const extracted = extractPhoneFromRequest(req);
    const phone = normalizePhone(req.body?.phone) || extracted;
    const result = await handleGetUserHistory({ phone });
    res.json(result);
  } catch (err) {
    console.error("[tools/get_user_history] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/tools/search_recipes", async (req, res) => {
  try {
    console.log("[tools/search_recipes] body:", JSON.stringify(req.body));
    const params = req.body?.parameters || req.body?.input || req.body || {};
    const extracted = extractPhoneFromRequest(req);
    const phone = normalizePhone(params?.phone) || extracted;
    const result = await handleSearchRecipes({ ...params, ingredients: params.ingredients, phone });
    res.json(result);
  } catch (err) {
    console.error("[tools/search_recipes] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/tools/get_recipe_details", async (req, res) => {
  try {
    const result = await handleGetRecipeDetails(req.body);
    res.json(result);
  } catch (err) {
    console.error("[tools/get_recipe_details] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/tools/send_recipe_sms", async (req, res) => {
  try {
    const extracted = extractPhoneFromRequest(req);
    const phone = normalizePhone(req.body?.phone) || extracted;
    const result = await handleSendRecipeSms({ ...req.body, phone });
    res.json(result);
  } catch (err) {
    console.error("[tools/send_recipe_sms] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/tools/save_preference", async (req, res) => {
  try {
    const extracted = extractPhoneFromRequest(req);
    const phone = normalizePhone(req.body?.phone) || extracted;
    const result = await handleSavePreference({ ...req.body, phone });
    res.json(result);
  } catch (err) {
    console.error("[tools/save_preference] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MCP SERVER
// Satisfies the MCP integration requirement.
// Uses the same shared handlers above — no duplicated logic.
// ============================================================
function getMcpServer() {
  const server = new McpServer({ name: "fridge-to-meal", version: "1.0.0" });

  server.tool("get_user_history", "Get the full history and dietary preferences for a caller",
    {
      phone: z.string().optional().describe("Caller phone number"),
      from: z.string().optional().describe("Caller phone number (alt field)"),
      caller_id: z.string().optional().describe("Caller phone number (alt field)"),
      caller_phone: z.string().optional().describe("Caller phone number (alt field)"),
      callerPhone: z.string().optional().describe("Caller phone number (alt field)"),
    },
    async ({ phone, from, caller_id, caller_phone, callerPhone }) => {
      const normalized = normalizePhone(phone) || normalizePhone(from) || normalizePhone(caller_id) || normalizePhone(caller_phone) || normalizePhone(callerPhone);
      return {
        content: [{ type: "text", text: JSON.stringify(await handleGetUserHistory({ phone: normalized }), null, 2) }],
      };
    }
  );

  server.tool("search_recipes", "Search for real recipes based on ingredients the caller has",
    {
      ingredients: z.array(z.string()).describe("Ingredients the caller has"),
      phone: z.string().optional().describe("Caller phone number to apply dietary filters"),
      from: z.string().optional().describe("Caller phone number (alt field)"),
    },
    async ({ ingredients, phone, from }) => {
      const normalized = normalizePhone(phone) || normalizePhone(from);
      return {
        content: [{ type: "text", text: JSON.stringify(await handleSearchRecipes({ ingredients, phone: normalized }), null, 2) }],
      };
    }
  );

  server.tool("get_recipe_details", "Get full recipe instructions and nutrition for a recipe the caller picked",
    { recipe_id: z.number().describe("Spoonacular recipe ID") },
    async ({ recipe_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await handleGetRecipeDetails({ recipe_id }), null, 2) }],
    })
  );

  server.tool("send_recipe_sms", "Text the full recipe instructions to the caller's phone number",
    {
      phone: z.string().optional().describe("Caller phone number"),
      from: z.string().optional().describe("Caller phone number (alt field)"),
      recipe_name: z.string().describe("Name of the recipe"),
      instructions: z.string().describe("Recipe instructions"),
      cook_time: z.string().optional().describe("Cook time"),
    },
    async ({ phone, from, recipe_name, instructions, cook_time }) => {
      const normalized = normalizePhone(phone) || normalizePhone(from);
      return {
        content: [{ type: "text", text: JSON.stringify(await handleSendRecipeSms({ phone: normalized, recipe_name, instructions, cook_time }), null, 2) }],
      };
    }
  );

  server.tool("save_preference", "Save the caller's meal choice and dietary preferences",
    {
      phone: z.string().optional().describe("Caller phone number"),
      from: z.string().optional().describe("Caller phone number (alt field)"),
      meal_name: z.string().describe("Name of the meal"),
      liked: z.boolean().describe("Whether the caller liked it"),
      dietary: z.string().optional().describe("Dietary restriction"),
      low_carb: z.boolean().optional().describe("Wants low carb"),
      high_protein: z.boolean().optional().describe("Wants high protein"),
    },
    async ({ phone, from, meal_name, liked, dietary, low_carb, high_protein }) => {
      const normalized = normalizePhone(phone) || normalizePhone(from);
      return {
        content: [{ type: "text", text: JSON.stringify(await handleSavePreference({ phone: normalized, meal_name, liked, dietary, low_carb, high_protein }), null, 2) }],
      };
    }
  );

  return server;
}

// MCP tool discovery (GET)
app.get("/mcp", (req, res) => {
  res.json({
    tools: [
      { name: "get_user_history", description: "Get the full history and dietary preferences for a caller", inputSchema: { type: "object", properties: { phone: { type: "string" } }, required: ["phone"] } },
      { name: "search_recipes", description: "Search for real recipes based on ingredients the caller has", inputSchema: { type: "object", properties: { ingredients: { type: "array", items: { type: "string" } }, phone: { type: "string" } }, required: ["ingredients"] } },
      { name: "get_recipe_details", description: "Get full recipe instructions and nutrition", inputSchema: { type: "object", properties: { recipe_id: { type: "number" } }, required: ["recipe_id"] } },
      { name: "send_recipe_sms", description: "Text the recipe to the caller", inputSchema: { type: "object", properties: { phone: { type: "string" }, recipe_name: { type: "string" }, instructions: { type: "string" }, cook_time: { type: "string" } }, required: ["phone", "recipe_name", "instructions"] } },
      { name: "save_preference", description: "Save the caller's meal choice and dietary preferences", inputSchema: { type: "object", properties: { phone: { type: "string" }, meal_name: { type: "string" }, liked: { type: "boolean" }, dietary: { type: "string" }, low_carb: { type: "boolean" }, high_protein: { type: "boolean" } }, required: ["phone", "meal_name", "liked"] } },
    ],
  });
});

// MCP tool calls (POST)
app.post("/mcp", async (req, res) => {
  const server = getMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
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

// Keep-alive ping — prevents Railway from sleeping
setInterval(async () => {
  try {
    await fetch(`http://localhost:${PORT}/`);
    console.log("[keep-alive] ping");
  } catch (err) {
    console.error("[keep-alive] failed:", err.message);
  }
}, 5 * 60 * 1000);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`fridge-to-meal server listening on port ${PORT}`));