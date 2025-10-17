import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import QRCode from "https://esm.sh/qrcode@1.5.1?target=deno";
import { ZodError } from "https://esm.sh/zod@3.22.4?target=deno";

import { supabaseAdmin, jsonResponse, withCorsHeaders } from "../_shared/client.ts";
import {
  campaignPayloadSchema,
  assertPromotionConsistency,
  sanitizeCampaignPayload,
} from "../_shared/validation.ts";
import { generateToken } from "../_shared/token.ts";
import { sendSummaryEmail } from "../_shared/email.ts";

interface QrResponse {
  token: string;
  url: string;
  dataUrl: string;
}

function buildQrUrl(baseUrl: string, token: string) {
  const normalized = baseUrl.replace(/\/$/, "");
  return `${normalized}/${token}`;
}

async function generateQrData(url: string) {
  return await QRCode.toDataURL(url, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 512,
  });
}

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
    assertPromotionConsistency(payload);
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

  const campaignInput = sanitizeCampaignPayload(payload);
  const publicToken = generateToken();
  const testToken = generateToken();
  const baseAppUrl = Deno.env.get("PUBLIC_APP_URL") ?? new URL(req.url).origin;
  const qrBaseUrl = `${baseAppUrl.replace(/\/$/, "")}/qr`;

  const { data: campaign, error: insertError } = await supabaseAdmin
    .from("campaigns")
    .insert(campaignInput)
    .select()
    .single();

  if (insertError || !campaign) {
    console.error("Failed to insert campaign", insertError);
    return jsonResponse({ error: "Failed to create campaign" }, { status: 500 });
  }

  const { data: qrCodes, error: qrError } = await supabaseAdmin
    .from("qr_codes")
    .insert([
      { campaign_id: campaign.id, token: publicToken, is_test: false },
      { campaign_id: campaign.id, token: testToken, is_test: true },
    ])
    .select();

  if (qrError || !qrCodes) {
    console.error("Failed to insert qr codes", qrError);
    await supabaseAdmin.from("campaigns").delete().eq("id", campaign.id);
    return jsonResponse({ error: "Failed to create campaign" }, { status: 500 });
  }

  const publicQrRow = qrCodes.find((row) => !row.is_test);
  const testQrRow = qrCodes.find((row) => row.is_test);

  if (!publicQrRow || !testQrRow) {
    await supabaseAdmin.from("campaigns").delete().eq("id", campaign.id);
    await supabaseAdmin.from("qr_codes").delete().eq("campaign_id", campaign.id);
    return jsonResponse({ error: "Failed to create campaign" }, { status: 500 });
  }

  const publicQrUrl = buildQrUrl(qrBaseUrl, publicQrRow.token);
  const testQrUrl = buildQrUrl(qrBaseUrl, testQrRow.token);

  const [publicQrDataUrl, testQrDataUrl] = await Promise.all([
    generateQrData(publicQrUrl),
    generateQrData(testQrUrl),
  ]);

  await sendSummaryEmail({
    email: payload.email,
    publicUrl: publicQrUrl,
    testUrl: testQrUrl,
    maxScans: payload.maxScans,
    promotionType: payload.promotionType,
    promoCode: payload.promoCode ?? null,
    redirectUrl: payload.redirectUrl ?? null,
    cashierCode: payload.cashierCode ?? null,
  });

  const publicQr: QrResponse = {
    token: publicQrRow.token,
    url: publicQrUrl,
    dataUrl: publicQrDataUrl,
  };

  const testQr: QrResponse = {
    token: testQrRow.token,
    url: testQrUrl,
    dataUrl: testQrDataUrl,
  };

  return jsonResponse(
    {
      campaignId: campaign.id,
      maxScans: campaign.max_scans,
      promotionType: campaign.promotion_type,
      promoCode: campaign.promo_code,
      redirectUrl: campaign.redirect_url,
      imageUrl: campaign.image_url,
      cashierCode: campaign.cashier_code,
      title: campaign.title,
      description: campaign.description,
      publicQr,
      testQr,
    },
    { status: 201 },
  );
});
