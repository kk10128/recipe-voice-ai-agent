const express = require("express");
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// --- Persistent user store backed by a JSON file.
// phone -> { callCount, lastMeal, preferences: { dietary, wantLowCarb, wantHighProtein }, likedMeals[] }
// Survives server restarts. For true cross-deployment persistence attach a
// Railway volume at /data and set USER_STORE_PATH=/data/users.json.
const LOCAL_USER_STORE_PATH = path.join(__dirname, "../../users.json");
// Prefer Railway's persistent volume mount point if present.
const DEFAULT_USER_STORE_PATH = "/data/users.json";
const USER_STORE_PATH =
  process.env.USER_STORE_PATH ||
  (fs.existsSync("/data") ? DEFAULT_USER_STORE_PATH : LOCAL_USER_STORE_PATH);
const userStore = {};

function loadUserStore() {
  try {
    if (fs.existsSync(USER_STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(USER_STORE_PATH, "utf8"));
      // Re-key phone numbers into a consistent "+E164" format.
      for (const [rawKey, value] of Object.entries(data)) {
        const keyStr = String(rawKey);
        if (keyStr.includes("{{") && keyStr.includes("}}")) continue;
        const digits = keyStr.replace(/\D/g, "");
        if (digits.length < 7) continue;
        userStore[`+${digits}`] = value;
      }
      console.log(`[store] loaded ${Object.keys(data).length} user(s) from ${USER_STORE_PATH}`);
    } else {
      console.log(`[store] no existing user store at ${USER_STORE_PATH} (starting fresh)`);
    }
  } catch (err) {
    console.error("[store] failed to load user store:", err.message);
  }
}

function saveUserStore() {
  try {
    fs.mkdirSync(path.dirname(USER_STORE_PATH), { recursive: true });
    fs.writeFileSync(USER_STORE_PATH, JSON.stringify(userStore, null, 2));
  } catch (err) {
    console.error("[store] failed to save user store:", err.message);
  }
}

loadUserStore();
// Per-call context so tool calls don't rely on global "last caller" state.
// call_id -> { phone }
const callContextStore = {};

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(s)) return true;
  if (["false", "f", "no", "n", "0"].includes(s)) return false;
  return false;
}

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

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return "";
  // Always key by '+digits' so we don't split users into '147...' vs '+147...'.
  return `+${digits}`;
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
    headers["x-telnyx-caller-id"],
    headers["x-caller-id"],
    headers["x-phone-number"],
    headers["x-telnyx-phone-number"],
  ];

  for (const c of candidates) {
    const p = normalizePhone(c);
    if (p) return p;
  }
  return "";
}

function normalizeCallId(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // If templating didn't run, we might get literal placeholders.
  if (trimmed.includes("{{") && trimmed.includes("}}")) return "";
  return trimmed;
}

function extractCallIdFromRequest(req) {
  const body = req?.body || {};
  const headers = req?.headers || {};

  const candidates = [
    body.call_control_id,
    body.callControlId,
    body.call_id,
    body.callId,
    body.conversation_id,
    body.conversationId,
    // Common Telnyx-ish nesting shapes
    body?.data?.call_control_id,
    body?.data?.callId,
    body?.data?.payload?.call_control_id,
    body?.data?.payload?.callId,
    body?.payload?.call_control_id,
    body?.payload?.callId,
    body?.payload?.conversation_id,
    // Common headers (best-effort)
    headers["x-call-control-id"],
    headers["x-call-id"],
    headers["x-telnyx-call-control-id"],
    headers["x-telnyx-call-id"],
    headers["x-conversation-id"],
    headers["x-telnyx-conversation-id"],
    headers["x-session-id"],
    headers["x-telnyx-session-id"],
  ];

  for (const c of candidates) {
    const id = normalizeCallId(c);
    if (id) return id;
  }
  return "";
}

function resolvePhone({ phone, call_id }) {
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) return normalizedPhone;

  const normalizedCallId = normalizeCallId(call_id);
  if (normalizedCallId) {
    const ctx = callContextStore[normalizedCallId];
    if (ctx?.phone) return ctx.phone;
  }

  return "";
}

async function fetchJsonWithTimeout(url, { timeoutMs = 12000, ...options } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (response.ok) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`upstream_non_json_success (${response.status})`);
      }
    }

    const text = await response.text();
    const excerpt = text ? text.slice(0, 700) : "";
    throw new Error(`upstream_error (${response.status}): ${excerpt || "unknown_error"}`);
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`fetch_timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
  let callerPhone = extractPhoneFromRequest(req);
  const callId = extractCallIdFromRequest(req);

  // Sometimes Telnyx sends a webhook event where phone extraction fails, but
  // we already captured the phone for this call_id earlier.
  if (!callerPhone && callId && callContextStore[callId]?.phone) {
    callerPhone = callContextStore[callId].phone;
  }

  const existingUser = callerPhone ? userStore[callerPhone] : undefined;
  const isReturning = !!(existingUser && existingUser.callCount > 0);

  if (!callerPhone) {
    // Helpful for diagnosing why greeting_type is coming back "new".
    // Redact potential signature fields.
    const redactedHeaders = Object.fromEntries(
      Object.entries(req.headers || {}).map(([k, v]) => {
        if (k.toLowerCase().includes("signature")) return [k, "(redacted)"];
        return [k, v];
      })
    );
    console.log(
      "[webhook][debug] callerPhone empty. body=" + JSON.stringify(req.body || {}) + " headers=" + JSON.stringify(redactedHeaders)
    );
  }

  // Increment call count at call start so "returning" greeting works even
  // if the caller doesn't accept SMS (which is when save_preference runs).
  if (callerPhone) {
    if (!userStore[callerPhone]) {
      userStore[callerPhone] = { callCount: 0, lastMeal: "nothing yet", preferences: {}, likedMeals: [] };
    }
    userStore[callerPhone].callCount += 1;
    saveUserStore();
  }

  const user = callerPhone ? userStore[callerPhone] : undefined;

  console.log(`[webhook] call from ${callerPhone}`);
  if (callerPhone && callId) {
    callContextStore[callId] = { phone: callerPhone, updatedAtMs: Date.now() };
  }

  const preferences = user?.preferences || {};

  console.log(
    `[webhook] callerPhone=${callerPhone || "(empty)"} callId=${callId || "(empty)"} greeting_type=${
      isReturning ? "returning" : "new"
    } previous_callCount=${existingUser?.callCount ?? 0}`
  );

  const opening_line = isReturning
    ? `Hey, welcome back! Last time you made ${user?.lastMeal || "something tasty"}. What are you working with tonight?`
    : "Hey! I'm Fridge Friend. Any dietary restrictions I should know about? Like vegetarian, vegan, gluten free, or low carb?";

  res.json({
    caller_phone: callerPhone,
    call_id: callId,
    greeting_type: isReturning ? "returning" : "new",
    opening_line,
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

async function handleGetUserHistory({ phone, call_id }) {
  const target = resolvePhone({ phone, call_id });
  console.log(`[tool] get_user_history for ${target || phone || call_id}`);
  const user = target ? userStore[target] : null;
  return (
    user || {
    callCount: 0,
    lastMeal: "nothing yet",
    preferences: {},
    likedMeals: [],
    }
  );
}

async function handleSearchRecipes({ ingredients, phone, call_id }) {
  console.log(`[tool] search_recipes for ${ingredients}`);
  const target = resolvePhone({ phone, call_id });
  const user = target ? userStore[target] : null;
  const dietary = user?.preferences?.dietary || "";
  const lowCarb = user?.preferences?.wantLowCarb || false;

  let dietParam = "";
  if (dietary === "vegetarian") dietParam = "&diet=vegetarian";
  else if (dietary === "vegan") dietParam = "&diet=vegan";
  else if (dietary === "gluten-free") dietParam = "&diet=gluten+free";
  else if (lowCarb) dietParam = "&diet=low-carb";

  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) return { error: "missing_spoonacular_api_key" };

  const url = `https://api.spoonacular.com/recipes/findByIngredients?ingredients=${encodeURIComponent(
    ingredients.join(",")
  )}&number=5&ranking=2&ignorePantry=true${dietParam}&apiKey=${apiKey}`;

  let recipes;
  try {
    recipes = await fetchJsonWithTimeout(url);
  } catch (err) {
    console.error("[tool] search_recipes failed:", err.message);
    return { error: "spoonacular_search_failed", message: err.message };
  }

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
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) return { error: "missing_spoonacular_api_key" };

  const url = `https://api.spoonacular.com/recipes/${recipe_id}/information?includeNutrition=true&apiKey=${apiKey}`;

  let recipe;
  try {
    recipe = await fetchJsonWithTimeout(url);
  } catch (err) {
    console.error("[tool] get_recipe_details failed:", err.message);
    return { error: "spoonacular_details_failed", message: err.message };
  }

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

async function handleSavePreference({ phone, call_id, meal_name, liked, dietary, low_carb, high_protein }) {
  const target = resolvePhone({ phone, call_id });
  console.log(`[tool] save_preference for ${target}: ${meal_name}`);
  if (!target) {
    return { saved: false, error: "missing_phone" };
  }
  const likedBool = coerceBoolean(liked);

  if (!userStore[target]) {
    userStore[target] = { callCount: 0, lastMeal: "", preferences: {}, likedMeals: [] };
  }

  const user = userStore[target];
  user.lastMeal = meal_name;
  user.callCount += 1;
  if (likedBool && !user.likedMeals.includes(meal_name)) user.likedMeals.push(meal_name);
  if (dietary) user.preferences.dietary = dietary;
  if (low_carb !== undefined) user.preferences.wantLowCarb = low_carb;
  if (high_protein !== undefined) user.preferences.wantHighProtein = high_protein;

  saveUserStore();
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
    const call_id = req.body?.call_id || req.body?.conversation_id || extractCallIdFromRequest(req);
    const phoneFromBody = normalizePhone(req.body?.phone);
    const phoneFromCallCtx = call_id ? callContextStore[call_id]?.phone : "";
    const phone = phoneFromBody || extracted || phoneFromCallCtx || "";
    const result = await handleGetUserHistory({ phone, call_id });
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
    const call_id = params?.call_id || params?.conversation_id || extractCallIdFromRequest(req);
    const phoneFromBody = normalizePhone(params?.phone);
    const phoneFromCallCtx = call_id ? callContextStore[call_id]?.phone : "";
    const phone = phoneFromBody || extracted || phoneFromCallCtx || "";
    const result = await handleSearchRecipes({ ...params, ingredients: params.ingredients, phone, call_id });
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

app.post("/tools/save_preference", async (req, res) => {
  try {
    const extracted = extractPhoneFromRequest(req);
    const call_id = req.body?.call_id || req.body?.conversation_id || extractCallIdFromRequest(req);
    const phoneFromBody = normalizePhone(req.body?.phone);
    const phoneFromCallCtx = call_id ? callContextStore[call_id]?.phone : "";
    const phone = phoneFromBody || extracted || phoneFromCallCtx || "";
    const result = await handleSavePreference({ ...req.body, phone, call_id });
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
      call_id: z.string().optional().describe("Telnyx call/conversation id"),
      from: z.string().optional().describe("Caller phone number (alt field)"),
      caller_id: z.string().optional().describe("Caller phone number (alt field)"),
      caller_phone: z.string().optional().describe("Caller phone number (alt field)"),
      callerPhone: z.string().optional().describe("Caller phone number (alt field)"),
    },
    async ({ phone, call_id, from, caller_id, caller_phone, callerPhone }) => {
      const normalized = normalizePhone(phone) || normalizePhone(from) || normalizePhone(caller_id) || normalizePhone(caller_phone) || normalizePhone(callerPhone);
      return {
        content: [{ type: "text", text: JSON.stringify(await handleGetUserHistory({ phone: normalized, call_id }), null, 2) }],
      };
    }
  );

  server.tool("search_recipes", "Search for real recipes based on ingredients the caller has",
    {
      ingredients: z.array(z.string()).describe("Ingredients the caller has"),
      phone: z.string().optional().describe("Caller phone number to apply dietary filters"),
      call_id: z.string().optional().describe("Telnyx call/conversation id"),
      from: z.string().optional().describe("Caller phone number (alt field)"),
    },
    async ({ ingredients, phone, call_id, from }) => {
      const normalized = normalizePhone(phone) || normalizePhone(from);
      return {
        content: [{ type: "text", text: JSON.stringify(await handleSearchRecipes({ ingredients, phone: normalized, call_id }), null, 2) }],
      };
    }
  );

  server.tool("get_recipe_details", "Get full recipe instructions and nutrition for a recipe the caller picked",
    { recipe_id: z.number().describe("Spoonacular recipe ID") },
    async ({ recipe_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await handleGetRecipeDetails({ recipe_id }), null, 2) }],
    })
  );

  server.tool("save_preference", "Save the caller's meal choice and dietary preferences",
    {
      phone: z.string().optional().describe("Caller phone number"),
      call_id: z.string().optional().describe("Telnyx call/conversation id"),
      from: z.string().optional().describe("Caller phone number (alt field)"),
      meal_name: z.string().describe("Name of the meal"),
      liked: z.union([z.boolean(), z.string()]).describe("Whether the caller liked it"),
      dietary: z.string().optional().describe("Dietary restriction"),
      low_carb: z.boolean().optional().describe("Wants low carb"),
      high_protein: z.boolean().optional().describe("Wants high protein"),
    },
    async ({ phone, call_id, from, meal_name, liked, dietary, low_carb, high_protein }) => {
      const normalized = normalizePhone(phone) || normalizePhone(from);
      return {
        content: [{ type: "text", text: JSON.stringify(await handleSavePreference({ phone: normalized, call_id, meal_name, liked, dietary, low_carb, high_protein }), null, 2) }],
      };
    }
  );

  return server;
}

// MCP tool discovery (GET)
app.get("/mcp", (req, res) => {
  res.json({
    tools: [
      { name: "get_user_history", description: "Get the full history and dietary preferences for a caller", inputSchema: { type: "object", properties: { phone: { type: "string" }, call_id: { type: "string" }, from: { type: "string" }, caller_id: { type: "string" }, caller_phone: { type: "string" } }, required: [] } },
      { name: "search_recipes", description: "Search for real recipes based on ingredients the caller has", inputSchema: { type: "object", properties: { ingredients: { type: "array", items: { type: "string" } }, phone: { type: "string" } }, required: ["ingredients"] } },
      { name: "get_recipe_details", description: "Get full recipe instructions and nutrition", inputSchema: { type: "object", properties: { recipe_id: { type: "number" } }, required: ["recipe_id"] } },
      { name: "save_preference", description: "Save the caller's meal choice and dietary preferences", inputSchema: { type: "object", properties: { phone: { type: "string" }, call_id: { type: "string" }, from: { type: "string" }, meal_name: { type: "string" }, liked: { type: "boolean" }, dietary: { type: "string" }, low_carb: { type: "boolean" }, high_protein: { type: "boolean" } }, required: ["meal_name", "liked"] } },
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