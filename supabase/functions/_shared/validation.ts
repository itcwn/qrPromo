import { z } from "https://esm.sh/zod@3.22.4?target=deno";

const promotionTypes = ["redirect", "promo_code", "image"] as const;

export const campaignPayloadSchema = z.object({
  email: z.string().email().max(255),
  maxScans: z.number().int().positive().max(100000),
  promotionType: z.enum(promotionTypes),
  redirectUrl: z.string().url().max(2048).optional(),
  promoCode: z.string().max(255).optional(),
  cashierCode: z.string().max(255).optional(),
  title: z.string().max(255).optional(),
  description: z.string().max(1024).optional(),
  imagePath: z.string().max(2048).optional(),
});

export type CampaignPayload = z.infer<typeof campaignPayloadSchema>;

export function resolveImageUrl(payload: CampaignPayload): string | null {
  if (payload.promotionType !== "image" || !payload.imagePath) {
    return null;
  }

  const bucket = Deno.env.get("PROMO_ASSET_BUCKET") ?? "promo-assets";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  if (!supabaseUrl) {
    throw new Error("Missing SUPABASE_URL environment variable");
  }

  const cleanedPath = payload.imagePath.replace(/^\/+/, "");
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${cleanedPath}`;
}

export function assertPromotionConsistency(payload: CampaignPayload) {
  if (payload.promotionType === "redirect" && !payload.redirectUrl) {
    throw new Error("redirectUrl is required for redirect promotions");
  }

  if (payload.promotionType === "promo_code" && !payload.promoCode) {
    throw new Error("promoCode is required for promo_code promotions");
  }

  if (payload.promotionType === "image" && !payload.imagePath) {
    throw new Error("imagePath is required for image promotions");
  }
}

export function sanitizeCampaignPayload(payload: CampaignPayload) {
  const imageUrl = resolveImageUrl(payload);

  return {
    email: payload.email,
    max_scans: payload.maxScans,
    promotion_type: payload.promotionType,
    promo_code: payload.promoCode ?? null,
    redirect_url: payload.redirectUrl ?? null,
    image_url: imageUrl,
    cashier_code: payload.cashierCode ?? null,
    title: payload.title ?? null,
    description: payload.description ?? null,
  };
}
