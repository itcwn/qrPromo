import QRCode from "https://esm.sh/qrcode@1.5.1?target=deno";
import { supabaseAdmin } from "./client.ts";
import {
  CampaignPayload,
  assertPromotionConsistency,
  sanitizeCampaignPayload,
} from "./validation.ts";
import { generateToken } from "./token.ts";
import { sendSummaryEmail } from "./email.ts";

export interface QrResponse {
  token: string;
  url: string;
  dataUrl: string;
}

export interface CampaignCreationResult {
  campaignId: string;
  maxScans: number;
  promotionType: string;
  promoCode: string | null;
  redirectUrl: string | null;
  imageUrl: string | null;
  cashierCode: string | null;
  title: string | null;
  description: string | null;
  publicQr: QrResponse;
  testQr: QrResponse;
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

export async function createCampaignFromPayload(
  payload: CampaignPayload,
  baseAppUrl: string,
): Promise<CampaignCreationResult> {
  assertPromotionConsistency(payload);
  const campaignInput = sanitizeCampaignPayload(payload);
  const publicToken = generateToken();
  const testToken = generateToken();
  const qrBaseUrl = `${baseAppUrl.replace(/\/$/, "")}/qr`;

  const { data: campaign, error: insertError } = await supabaseAdmin
    .from("campaigns")
    .insert(campaignInput)
    .select()
    .single();

  if (insertError || !campaign) {
    console.error("Failed to insert campaign", insertError);
    throw new Error("Failed to create campaign");
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
    throw new Error("Failed to create campaign");
  }

  const publicQrRow = qrCodes.find((row) => !row.is_test);
  const testQrRow = qrCodes.find((row) => row.is_test);

  if (!publicQrRow || !testQrRow) {
    await supabaseAdmin.from("campaigns").delete().eq("id", campaign.id);
    await supabaseAdmin.from("qr_codes").delete().eq("campaign_id", campaign.id);
    throw new Error("Failed to create campaign");
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

  return {
    campaignId: campaign.id,
    maxScans: campaign.max_scans,
    promotionType: campaign.promotion_type,
    promoCode: campaign.promo_code,
    redirectUrl: campaign.redirect_url,
    imageUrl: campaign.image_url,
    cashierCode: campaign.cashier_code,
    title: campaign.title,
    description: campaign.description,
    publicQr: {
      token: publicQrRow.token,
      url: publicQrUrl,
      dataUrl: publicQrDataUrl,
    },
    testQr: {
      token: testQrRow.token,
      url: testQrUrl,
      dataUrl: testQrDataUrl,
    },
  };
}
