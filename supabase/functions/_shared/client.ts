import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl) {
  throw new Error("Missing SUPABASE_URL environment variable");
}

if (!supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable");
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
  },
});

export function withCorsHeaders(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Access-Control-Allow-Origin", Deno.env.get("CORS_ALLOWED_ORIGIN") ?? "*");
  headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");

  return {
    ...init,
    headers,
  };
}

export function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), withCorsHeaders({ ...init, headers }));
}
