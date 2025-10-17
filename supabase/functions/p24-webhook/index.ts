import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { ZodError, z } from "https://esm.sh/zod@3.22.4?target=deno";

import { supabaseAdmin } from "../_shared/client.ts";
import { campaignPayloadSchema } from "../_shared/validation.ts";
import { createCampaignFromPayload } from "../_shared/campaign.ts";
import { getP24Config, signWithCrc } from "../_shared/p24.ts";

const numericLike = z.union([z.number().int(), z.string().regex(/^\d+$/)]);

const webhookSchema = z.object({
  merchantId: numericLike,
  posId: numericLike,
  sessionId: z.string(),
  amount: numericLike,
  currency: z.string(),
  orderId: numericLike,
  sign: z.string(),
  status: z.string(),
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405);
  }

  let payload: z.infer<typeof webhookSchema>;

  try {
    const json = await req.json();
    payload = webhookSchema.parse(json);
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonResponse({ error: "Invalid payload", details: error.flatten() }, 400);
    }

    return jsonResponse({ error: "Invalid payload" }, 400);
  }

  const config = getP24Config();
  const merchantId = Number(payload.merchantId);
  const posId = Number(payload.posId);
  const orderId = Number(payload.orderId);
  const amount = Number(payload.amount);
  const currency = payload.currency;

  if (merchantId !== config.merchantId || posId !== config.posId) {
    return jsonResponse({ error: "Merchant mismatch" }, 400);
  }

  const expectedSign = await signWithCrc(
    [payload.sessionId, orderId, amount, currency],
    config.crc,
  );

  if (payload.sign !== expectedSign) {
    console.warn("Invalid Przelewy24 signature", payload.sessionId);
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("id, status, campaign_id, campaign_payload")
    .eq("session_id", payload.sessionId)
    .maybeSingle();

  if (orderError) {
    console.error("Failed to load order", orderError);
    return jsonResponse({ error: "Failed to load order" }, 500);
  }

  if (!order) {
    return jsonResponse({ error: "Order not found" }, 404);
  }

  if (payload.status !== "success") {
    await supabaseAdmin
      .from("orders")
      .update({
        status: "failed",
        failure_reason: `Gateway status: ${payload.status}`,
      })
      .eq("id", order.id);

    return jsonResponse({ status: "acknowledged" });
  }

  if (order.status === "paid" && order.campaign_id) {
    return jsonResponse({ status: "already_processed" });
  }

  let campaignPayload;

  try {
    campaignPayload = campaignPayloadSchema.parse(order.campaign_payload);
  } catch (error) {
    console.error("Invalid campaign payload stored for order", order.id, error);
    await supabaseAdmin
      .from("orders")
      .update({
        status: "failed",
        failure_reason: "Stored payload invalid",
      })
      .eq("id", order.id);
    return jsonResponse({ error: "Stored payload invalid" }, 500);
  }

  try {
    const baseAppUrl = Deno.env.get("PUBLIC_APP_URL") ?? new URL(req.url).origin;
    const campaign = await createCampaignFromPayload(campaignPayload, baseAppUrl);

    await supabaseAdmin
      .from("orders")
      .update({
        status: "paid",
        campaign_id: campaign.campaignId,
        paid_at: new Date().toISOString(),
        failure_reason: null,
        p24_order_id: orderId,
      })
      .eq("id", order.id);

    return jsonResponse({ status: "processed", campaignId: campaign.campaignId });
  } catch (error) {
    console.error("Failed to finalize order", order.id, error);
    await supabaseAdmin
      .from("orders")
      .update({
        status: "failed",
        failure_reason: error instanceof Error ? error.message : "Unknown error",
      })
      .eq("id", order.id);

    return jsonResponse({ error: "Failed to finalize order" }, 500);
  }
});
