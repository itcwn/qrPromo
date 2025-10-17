import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

import { supabaseAdmin, withCorsHeaders } from "../_shared/client.ts";

interface ConsumeResult {
  campaign_id: string;
  status: "active" | "expired";
  remaining_scans: number;
  promotion_type: "redirect" | "promo_code" | "image";
  promo_code: string | null;
  redirect_url: string | null;
  image_url: string | null;
  cashier_code: string | null;
  is_test: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function renderHtml(result: ConsumeResult) {
  const { promotion_type, promo_code, image_url, cashier_code, remaining_scans, status, is_test } = result;
  const isExpired = status === "expired";

  const remainingInfo = isExpired
    ? "Promocja została zakończona."
    : `Pozostało <strong>${remaining_scans}</strong> użyć.`;

  let content = "";

  if (promotion_type === "promo_code" && promo_code) {
    content = `<p class="value">Kod promocyjny:</p><p class="badge">${escapeHtml(promo_code)}</p>`;
  } else if (promotion_type === "image" && image_url) {
    content = `<img src="${escapeHtml(image_url)}" alt="Grafika promocji" class="promo-image" />`;
  } else if (promotion_type === "redirect" && result.redirect_url) {
    content = `<p class="value">Promocja przekierowuje na:</p><p class="badge">${escapeHtml(result.redirect_url)}</p>`;
  } else {
    content = `<p class="value">Ta promocja jest chwilowo niedostępna.</p>`;
  }

  const cashierSection = cashier_code
    ? `<p class="cashier">Kod kasowy: <strong>${escapeHtml(cashier_code)}</strong></p>`
    : "";

  const testBanner = is_test
    ? '<p class="test-badge">TRYB TESTOWY – licznik się nie zmniejsza</p>'
    : "";

  return `<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>QR Promo</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #0f172a;
        color: #f8fafc;
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
      }
      main {
        background: rgba(15, 23, 42, 0.85);
        border-radius: 16px;
        padding: 32px;
        max-width: 480px;
        width: calc(100% - 32px);
        box-shadow: 0 20px 45px rgba(15, 23, 42, 0.4);
      }
      h1 {
        font-size: 1.75rem;
        margin-top: 0;
      }
      p {
        line-height: 1.5;
      }
      .value {
        margin-top: 24px;
        font-weight: 600;
      }
      .badge {
        margin: 12px 0 24px;
        display: inline-block;
        padding: 12px 18px;
        border-radius: 12px;
        background: linear-gradient(135deg, #38bdf8, #6366f1);
        font-size: 1.5rem;
        font-weight: 700;
        color: #0f172a;
        letter-spacing: 0.02em;
      }
      .promo-image {
        width: 100%;
        border-radius: 12px;
        box-shadow: 0 10px 25px rgba(15, 23, 42, 0.45);
        margin: 16px 0 24px;
      }
      .cashier {
        margin-top: 16px;
        font-size: 0.95rem;
        opacity: 0.8;
      }
      .test-badge {
        margin: 0 0 16px;
        padding: 8px 12px;
        border-radius: 9999px;
        background: rgba(190, 242, 100, 0.15);
        color: #bef264;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.75rem;
      }
      footer {
        margin-top: 32px;
        font-size: 0.75rem;
        opacity: 0.6;
      }
    </style>
  </head>
  <body>
    <main>
      ${testBanner}
      <h1>${isExpired ? "Promocja zakończona" : "Promocja QR"}</h1>
      <p>${remainingInfo}</p>
      ${content}
      ${cashierSection}
      <footer>Obsługiwane przez Supabase Edge Functions</footer>
    </main>
  </body>
</html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", withCorsHeaders({ status: 200 }));
  }

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const token = segments[1];

  if (!token) {
    return new Response("Nie znaleziono kodu", withCorsHeaders({ status: 404 }));
  }

  const { data, error } = await supabaseAdmin.rpc("consume_campaign_scan", {
    p_token: token,
  });

  if (error) {
    console.error("Failed to consume scan", error);
    return new Response("Błąd serwera", withCorsHeaders({ status: 500 }));
  }

  if (!data || data.length === 0) {
    return new Response("Nie znaleziono kodu", withCorsHeaders({ status: 404 }));
  }

  const result = data[0] as ConsumeResult;

  const headers = new Headers({
    "Cache-Control": "no-store",
  });

  if (
    result.status !== "expired" &&
    result.promotion_type === "redirect" &&
    result.redirect_url
  ) {
    headers.set("Location", result.redirect_url);
    return new Response(null, withCorsHeaders({ status: 302, headers }));
  }

  const html = renderHtml(result);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, withCorsHeaders({ status: result.status === "expired" ? 410 : 200, headers }));
});
