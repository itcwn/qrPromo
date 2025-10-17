interface SummaryPayload {
  email: string;
  publicUrl: string;
  testUrl: string;
  maxScans: number;
  promotionType: string;
  promoCode?: string | null;
  redirectUrl?: string | null;
  cashierCode?: string | null;
}

export async function sendSummaryEmail(payload: SummaryPayload) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");

  if (!apiKey || !from) {
    return;
  }

  const subject = `Twoja kampania QR (${payload.promotionType})`;
  const lines = [
    `Maksymalna liczba skanów: ${payload.maxScans}`,
    `Link publiczny: ${payload.publicUrl}`,
    `Link testowy: ${payload.testUrl}`,
  ];

  if (payload.promoCode) {
    lines.push(`Kod promocyjny: ${payload.promoCode}`);
  }

  if (payload.redirectUrl) {
    lines.push(`Adres docelowy: ${payload.redirectUrl}`);
  }

  if (payload.cashierCode) {
    lines.push(`Kod kasowy: ${payload.cashierCode}`);
  }

  const text = lines.join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: payload.email,
      subject,
      text,
    }),
  });

  if (!res.ok) {
    console.warn("Failed to send summary email", await res.text());
  }
}
