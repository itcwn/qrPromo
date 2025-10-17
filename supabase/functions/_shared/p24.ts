const DEFAULT_API_URL = "https://sandbox.przelewy24.pl/api/v1";
const DEFAULT_PAYMENT_URL = "https://sandbox.przelewy24.pl";

export interface P24Config {
  merchantId: number;
  posId: number;
  apiKey: string;
  crc: string;
  apiUrl: string;
  paymentUrl: string;
  returnUrl?: string;
  statusUrl?: string;
}

export interface RegisterTransactionParams {
  sessionId: string;
  amount: number;
  currency: string;
  description: string;
  email: string;
  country: string;
  language: string;
  urlReturn: string;
  urlStatus: string;
  customerIp?: string;
}

export interface RegisterTransactionResult {
  token: string;
  orderId: number;
}

export interface VerifyTransactionResult {
  status: string;
}

function parseNumberEnv(value: string | undefined, name: string): number {
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return parsed;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }

  return value;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha384(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-384", data);
  return toHex(digest);
}

export function getP24Config(): P24Config {
  return {
    merchantId: parseNumberEnv(Deno.env.get("P24_MERCHANT_ID"), "P24_MERCHANT_ID"),
    posId: parseNumberEnv(Deno.env.get("P24_POS_ID"), "P24_POS_ID"),
    apiKey: requireEnv(Deno.env.get("P24_REST_API_KEY"), "P24_REST_API_KEY"),
    crc: requireEnv(Deno.env.get("P24_CRC"), "P24_CRC"),
    apiUrl: Deno.env.get("P24_API_URL") ?? DEFAULT_API_URL,
    paymentUrl: Deno.env.get("P24_PAYMENT_URL") ?? DEFAULT_PAYMENT_URL,
    returnUrl: Deno.env.get("P24_RETURN_URL") ?? undefined,
    statusUrl: Deno.env.get("P24_STATUS_URL") ?? undefined,
  };
}

function buildAuthHeader(config: P24Config) {
  const credentials = `${config.posId}:${config.apiKey}`;
  const encoded = btoa(credentials);
  return `Basic ${encoded}`;
}

export async function signWithCrc(parts: Array<string | number>, crc: string) {
  const message = [...parts.map((part) => part.toString()), crc].join("|");
  return await sha384(message);
}

async function p24Fetch<T>(
  config: P24Config,
  path: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${config.apiUrl.replace(/\/$/, "")}/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildAuthHeader(config),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      console.error("Failed to parse Przelewy24 response", text);
      throw new Error("Unexpected response from Przelewy24");
    }
  }

  if (!response.ok) {
    console.error("Przelewy24 API error", response.status, parsed ?? text);
    throw new Error("Przelewy24 API request failed");
  }

  const data =
    parsed && typeof parsed === "object" && parsed !== null && "data" in parsed
      ? (parsed as { data: T }).data
      : (parsed as T | null);

  if (!data) {
    console.error("Przelewy24 API empty payload", parsed);
    throw new Error("Przelewy24 API returned empty payload");
  }

  return data;
}

export async function registerTransaction(
  config: P24Config,
  params: RegisterTransactionParams,
): Promise<RegisterTransactionResult> {
  const sign = await signWithCrc(
    [
      config.merchantId,
      config.posId,
      params.sessionId,
      params.amount,
      params.currency,
    ],
    config.crc,
  );

  const payload = {
    merchantId: config.merchantId,
    posId: config.posId,
    sessionId: params.sessionId,
    amount: params.amount,
    currency: params.currency,
    description: params.description,
    email: params.email,
    country: params.country,
    language: params.language,
    urlReturn: params.urlReturn,
    urlStatus: params.urlStatus,
    customerIp: params.customerIp ?? "127.0.0.1",
    sign,
  };

  const data = await p24Fetch<RegisterTransactionResult>(
    config,
    "transaction/register",
    "POST",
    payload,
  );

  return data;
}

export async function chargeBlik(
  config: P24Config,
  token: string,
  blikCode: string,
) {
  const sign = await signWithCrc([
    config.merchantId,
    token,
    blikCode,
  ], config.crc);

  await p24Fetch(config, "paymentmethods/blik/charge", "POST", {
    merchantId: config.merchantId,
    posId: config.posId,
    token,
    blikCode,
    sign,
  });
}

export async function verifyTransaction(
  config: P24Config,
  sessionId: string,
  amount: number,
  currency: string,
  orderId: number,
): Promise<VerifyTransactionResult> {
  const sign = await signWithCrc([
    sessionId,
    orderId,
    amount,
    currency,
  ], config.crc);

  return await p24Fetch<VerifyTransactionResult>(
    config,
    "transaction/verify",
    "PUT",
    {
      merchantId: config.merchantId,
      posId: config.posId,
      sessionId,
      amount,
      currency,
      orderId,
      sign,
    },
  );
}

export function buildRedirectUrl(config: P24Config, token: string) {
  const base = config.paymentUrl.replace(/\/$/, "");
  return `${base}/trnRequest/${token}`;
}
