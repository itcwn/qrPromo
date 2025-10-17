import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { ZodError } from "https://esm.sh/zod@3.22.4?target=deno";

import { jsonResponse, withCorsHeaders } from "../_shared/client.ts";
import {
  campaignPayloadSchema,
} from "../_shared/validation.ts";
import { createCampaignFromPayload } from "../_shared/campaign.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", withCorsHeaders({ status: 200 }));
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", withCorsHeaders({ status: 405 }));
  }

  let payload;

  try {
    const json = await req.json();
    payload = campaignPayloadSchema.parse(json);
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonResponse(
        { error: "Invalid payload", details: error.flatten() },
        { status: 400 },
      );
    }

    return jsonResponse(
      { error: error instanceof Error ? error.message : "Invalid payload" },
      { status: 400 },
    );
  }

  try {
    const baseAppUrl = Deno.env.get("PUBLIC_APP_URL") ?? new URL(req.url).origin;
    const campaign = await createCampaignFromPayload(payload, baseAppUrl);

    return jsonResponse(campaign, { status: 201 });
  } catch (error) {
    console.error("Failed to create campaign", error);
    return jsonResponse({ error: "Failed to create campaign" }, { status: 500 });
  }
});
