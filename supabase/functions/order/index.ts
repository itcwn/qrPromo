import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { ZodError, z } from "https://esm.sh/zod@3.22.4?target=deno";

import { jsonResponse, supabaseAdmin, withCorsHeaders } from "../_shared/client.ts";
import { campaignPayloadSchema, CampaignPayload } from "../_shared/validation.ts";
import { createCampaignFromPayload } from "../_shared/campaign.ts";
import {
  buildRedirectUrl,
  chargeBlik,
  getP24Config,
  registerTransaction,
  verifyTransaction,
} from "../_shared/p24.ts";

const extensionSchema = z.object({
  units: z.number().int().min(0).max(365),
  extraDays: z.number().int().min(0),
  extraCost: z.number().min(0),
  totalValidityDays: z.number().int().positive(),
});

const paymentSchema = z.object({
  method: z.enum(["blik", "transfer"]),
  code: z.string().regex(/^\d{6}$/).optional(),
});

const orderSchema = campaignPayloadSchema.extend({
  campaignStart: z.string().max(64).optional(),
  invoiceRequested: z.boolean().default(false),
  invoiceDetails: z.string().max(2048).optional(),
  notes: z.string().max(2048).optional(),
  price: z.number().positive(),
  extension: extensionSchema,
  payment: paymentSchema,
}).superRefine((data, ctx) => {
  if (data.payment.method === "blik" && !data.payment.code) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BLIK code is required for BLIK payments",
      path: ["payment", "code"],
    });
  }
});

interface OrderRow {
  id: string;
}

function sanitizePayloadForStorage(order: z.infer<typeof orderSchema>) {
  const { payment, ...rest } = order;
  return {
    ...rest,
    payment: {
      method: payment.method,
    },
  };
}

function buildCampaignPayload(order: z.infer<typeof orderSchema>): CampaignPayload {
  return {
    email: order.email,
    maxScans: order.maxScans,
    promotionType: order.promotionType,
    promoCode: order.promoCode,
    redirectUrl: order.redirectUrl,
    imagePath: order.imagePath,
    cashierCode: order.cashierCode,
    title: order.title,
    description: order.description,
  };
}

function safeAmount(price: number) {
  const amount = Math.round(price * 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid amount computed from price");
  }
  return amount;
}

function buildDescription(order: z.infer<typeof orderSchema>) {
  const base = `Kampania QR dla ${order.email}`;
  return base.length > 255 ? base.slice(0, 252) + "..." : base;
}

function resolveReturnUrl(baseAppUrl: string) {
  const frontend = Deno.env.get("PUBLIC_FRONTEND_URL");
  return Deno.env.get("P24_RETURN_URL") ?? frontend ?? baseAppUrl;
}

function resolveStatusUrl(baseAppUrl: string) {
  const config = Deno.env.get("P24_STATUS_URL");
  if (config) {
    return config;
  }
  return `${baseAppUrl.replace(/\/$/, "")}/p24-webhook`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", withCorsHeaders({ status: 200 }));
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", withCorsHeaders({ status: 405 }));
  }

  let orderPayload: z.infer<typeof orderSchema>;

  try {
    const body = await req.json();
    orderPayload = orderSchema.parse(body);
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

  const baseAppUrl = Deno.env.get("PUBLIC_APP_URL") ?? new URL(req.url).origin;
  const amount = safeAmount(orderPayload.price);
  const currency = "PLN";
  const sessionId = crypto.randomUUID();
  const description = buildDescription(orderPayload);
  const campaignPayload = buildCampaignPayload(orderPayload);
  const payloadForStorage = sanitizePayloadForStorage(orderPayload);
  const customerIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim();

  let orderRow: OrderRow | null = null;

  try {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("orders")
      .insert({
        session_id: sessionId,
        email: orderPayload.email,
        amount,
        currency,
        payment_method: orderPayload.payment.method,
        status: "pending",
        payload: payloadForStorage,
        campaign_payload: campaignPayload,
        extension: orderPayload.extension,
        invoice_requested: orderPayload.invoiceRequested,
        invoice_details: orderPayload.invoiceDetails ?? null,
        notes: orderPayload.notes ?? null,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      console.error("Failed to insert order", insertError);
      throw new Error("Failed to persist order");
    }

    orderRow = inserted;

    const config = getP24Config();
    const registerResult = await registerTransaction(config, {
      sessionId,
      amount,
      currency,
      description,
      email: orderPayload.email,
      country: "PL",
      language: "pl",
      urlReturn: config.returnUrl ?? resolveReturnUrl(baseAppUrl),
      urlStatus: config.statusUrl ?? resolveStatusUrl(baseAppUrl),
      customerIp,
    });

    const gatewayOrderId = Number(registerResult.orderId);
    if (!Number.isFinite(gatewayOrderId)) {
      throw new Error("Invalid order identifier returned by Przelewy24");
    }

    await supabaseAdmin
      .from("orders")
      .update({
        p24_token: registerResult.token,
        p24_order_id: gatewayOrderId,
      })
      .eq("id", inserted.id);

    if (orderPayload.payment.method === "transfer") {
      const redirectUrl = buildRedirectUrl(config, registerResult.token);
      return jsonResponse(
        {
          status: "pending",
          order: {
            id: inserted.id,
            sessionId,
            amount,
            currency,
          },
          payment: {
            method: "transfer",
            orderId: gatewayOrderId,
            redirectUrl,
          },
        },
        { status: 202 },
      );
    }

    const blikCode = orderPayload.payment.code ?? "";
    await chargeBlik(config, registerResult.token, blikCode);
    const verification = await verifyTransaction(
      config,
      sessionId,
      amount,
      currency,
      gatewayOrderId,
    );

    if (verification.status !== "success") {
      throw new Error("BLIK payment not confirmed");
    }

    const campaign = await createCampaignFromPayload(campaignPayload, baseAppUrl);

    await supabaseAdmin
      .from("orders")
      .update({
        status: "paid",
        campaign_id: campaign.campaignId,
        paid_at: new Date().toISOString(),
        failure_reason: null,
      })
      .eq("id", inserted.id);

    return jsonResponse(
      {
        status: "success",
        order: {
          id: inserted.id,
          sessionId,
          amount,
          currency,
        },
        payment: {
          method: "blik",
          orderId: gatewayOrderId,
        },
        campaign,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Order processing failed", error);

    if (orderRow) {
      await supabaseAdmin
        .from("orders")
        .update({
          status: "failed",
          failure_reason: error instanceof Error ? error.message : "Unknown error",
        })
        .eq("id", orderRow.id);
    }

    const message =
      error instanceof Error ? error.message : "Failed to process the order";

    return jsonResponse({ error: message }, { status: 502 });
  }
});
