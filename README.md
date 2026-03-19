## Fridge Friend

Fridge Friend is a Telnyx Voice AI assistant that helps callers cook with ingredients they already have at home.

## What It Solves

People often come home open their fridge, wonder what's for dinner, and have no idea what to cook. Fridge Friend turns a short phone call into a practical meal suggestions based on user preferences.

## Architecture

- `voice-agent/src/server.js`: Express backend + MCP server + dynamic webhook endpoint.
- Telnyx Assistant Builder: voice experience, tool orchestration, and call handling.
- Spoonacular API: recipe search and recipe details enrichment.
- Railway deployment: public backend for webhook variables and tools.

## MCP Tools

- `get_user_history`: returns prior meals and dietary preferences for personalization.
- `search_recipes`: finds recipes from caller ingredients, with preference-aware filtering.
- `get_recipe_details`: returns instructions, cook time, and nutrition details.
- `save_preference`: stores meal choices and preference updates for future calls.

## Dynamic Webhook Variables

`/webhook` returns dynamic context used directly in the assistant prompt:

- `caller_phone`
- `greeting_type`
- `opening_line`
- `last_meal`
- `call_count`
- `dietary_restrictions`
- `low_carb`
- `high_protein`
- `liked_meals`

This enables personalized greetings and preference-aware conversations.

## Real-World Reliability

- Normalizes caller phone values to a consistent `+digits` format.
- Falls back from tool `phone` input to `call_id` context when needed.
- Persists caller memory to `USER_STORE_PATH` (`/data/users.json` recommended on Railway volume).
- Handles upstream API failures with structured errors instead of crashing.

## Deployment Notes

- Public backend URL: hosted on Railway.
- For persistent memory across redeploys:
  - Attach a Railway volume at `/data`
  - Set `USER_STORE_PATH=/data/users.json`

## Example Call Flow

1. Caller shares dietary needs and available ingredients.
2. Assistant offers best-fit options.
3. Caller picks one meal.
4. Assistant reads recipe details for caller to create.
