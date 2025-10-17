# QR Promo – Supabase Edge Functions

Lekka implementacja backendu kampanii promocyjnych oparta w 100% na Supabase:
- **Edge Functions** generują kampanie i obsługują skanowanie kodów QR,
- **Postgres** przechowuje kampanie, tokeny QR oraz logi skanów,
- **Storage** (bucket `promo-assets`) może hostować grafiki wykorzystywane w promocjach.

Użytkownik końcowy definiuje liczbę dostępnych skanów oraz sposób działania promocji.
System automatycznie generuje dwa kody QR: publiczny i testowy (nie zmniejsza licznika).

## Architektura

```
┌──────────────┐      POST /create-campaign       ┌─────────────────────────────┐
│ Formularz /  │ ───────────────────────────────▶ │ Supabase Edge Function (Deno)│
│ panel klienta│                                   └─────────────┬───────────────┘
└──────────────┘                                                 │
                                                                 ▼
                                                        ┌─────────────────┐
                                                        │ Supabase Postgres│
                                                        │ + Storage bucket │
                                                        └─────────────────┘
                                                                 ▲
                  GET /qr/{token}                                │ RPC `consume_campaign_scan`
                ─────────────────────────────────────────────────┘
```

- `supabase/functions/create-campaign` – waliduje wejście, zapisuje kampanię,
  generuje tokeny, tworzy grafiki QR i opcjonalnie wysyła e-mail z podsumowaniem.
- `supabase/functions/order` – przyjmuje zamówienie z formularza, rejestruje
  transakcję w Przelewy24, pobiera kod BLIK lub przygotowuje przekierowanie na
  szybki przelew oraz – po potwierdzeniu płatności – tworzy kampanię i QR-y.
- `supabase/functions/p24-webhook` – odbiera notyfikacje statusu z Przelewy24,
  weryfikuje podpis i finalizuje kampanię dla przelewów (redirect) lub w razie
  błędu oznacza zamówienie jako nieudane.
- `supabase/functions/qr` – konsumuje skan (z użyciem funkcji SQL z licznikiem) i
  zwraca przekierowanie albo prosty widok HTML z informacją o promocji.
- Bucket `promo-assets` (publiczny) służy do przechowywania grafik dla promocji typu `image`.

## Wymagania

- [Supabase CLI](https://supabase.com/docs/guides/cli) z dostępem do projektu,
- środowisko Deno (CLI supabase pobiera je automatycznie podczas `functions serve`),
- opcjonalnie konto [Resend](https://resend.com/) do wysyłki podsumowań kampanii.

## Konfiguracja środowiska

1. Skopiuj plik `.env.example` do `.env` i uzupełnij wartości:
   - `SUPABASE_URL` oraz `SUPABASE_SERVICE_ROLE_KEY` – dane projektu Supabase,
   - `PUBLIC_APP_URL` – publiczny adres funkcji (np. `https://<ref>.functions.supabase.co`),
   - `PUBLIC_FRONTEND_URL` – adres hostowanej strony zamówienia (np. Netlify/Vercel),
   - `PROMO_ASSET_BUCKET` – nazwa bucketu na grafiki (domyślnie `promo-assets`),
   - `CORS_ALLOWED_ORIGIN` – adres panelu/klienta, który będzie wywoływał funkcję `create-campaign`,
   - `RESEND_API_KEY`, `EMAIL_FROM` – jeżeli chcesz wysyłać podsumowania e-mail.
   - `P24_MERCHANT_ID`, `P24_POS_ID`, `P24_REST_API_KEY`, `P24_CRC`, `P24_API_URL`,
     `P24_PAYMENT_URL`, `P24_RETURN_URL`, `P24_STATUS_URL` – konfiguracja Przelewy24.
     Zabezpiecz wartości, przechowując je jako Supabase secrets (`supabase functions secrets set`).
2. Utwórz storage bucket:
   ```bash
   supabase storage create-bucket promo-assets --public
   ```
   Grafiki możesz wgrywać przez panel Supabase lub `supabase storage upload`.
3. W konsoli SQL uruchom migrację `supabase/schema.sql`.
4. Zdeployuj funkcje:
   ```bash
   supabase functions deploy create-campaign
   supabase functions deploy qr
   ```

### Automatyczny deployment (PowerShell)

Na systemach Windows możesz wykonać pełne wdrożenie jedną komendą PowerShell.
Skrypt korzysta z pliku `.env`, oczekuje ustawionego tokenu CLI (`$Env:SUPABASE_ACCESS_TOKEN`)
i wykonuje wszystkie kroki po kolei: ustawienie sekretów funkcji, stworzenie bucketa,
aplikację schematu SQL oraz publikację Edge Functions.

```powershell
pwsh -File .\scripts\deploy-supabase.ps1 -ProjectRef your-project-ref
```

Parametry opcjonalne:

- `-EnvFile` – wskazuje inny plik ze zmiennymi środowiskowymi (domyślnie `.env`),
- `-BucketName` – wymusza nazwę bucketa (domyślnie pobierana z `PROMO_ASSET_BUCKET`).

Skrypt jest idempotentny – ponowne uruchomienie nie zgłosi błędu, jeżeli bucket już istnieje.

### Strona zamówień kampanii

W katalogu `web/order` znajduje się gotowa strona HTML z formularzem dla klientów
zamawiających kampanię QR. Zawiera ona opis funkcji, cennik (9,99 zł za
standardową kampanię) oraz dodatkowy przycisk aktywujący cenę promocyjną 4,99 zł
po polubieniu profilu na Facebooku. Formularz uwzględnia również opcję
„**Firma – Faktura VAT 23%**”, która pozwala klientowi przesłać dane rozliczeniowe.

Strona wywołuje funkcję `order` (adres należy uzupełnić w atrybucie
`data-endpoint` elementu `<body>`) i prezentuje wynik płatności. Możesz ją
hostować jako statyczny plik (np. na Vercel, Netlify czy w Supabase Storage).

### Integracja płatności Przelewy24

- Edge Function `order` zapisuje zamówienie w tabeli `orders`, rejestruje
  transakcję w P24, przelicza kwotę i w razie wyboru BLIK wykonuje od razu
  autoryzację (`paymentmethods/blik/charge` + `transaction/verify`).
- W przypadku szybkiego przelewu funkcja zwraca adres przekierowania
  `trnRequest`. Finalizacja następuje po stronie P24, a webhook `p24-webhook`
  (adres przekazywany w `P24_STATUS_URL` lub `PUBLIC_APP_URL/p24-webhook`)
  potwierdza podpis `SHA384` i tworzy kampanię.
- Sekrety Przelewy24 (`P24_*`) przechowuj jako Supabase secrets. Skrypt
  `scripts/deploy-supabase.ps1` ustawi je automatycznie na podstawie `.env`.

### Lokalny podgląd

Supabase CLI pozwala uruchomić funkcje lokalnie:

```bash
supabase functions serve create-campaign --env-file .env
supabase functions serve qr --env-file .env --listen 0.0.0.0:9999
```

Druga komenda pozwala na testowanie pod adresem `http://localhost:9999/qr/{token}`.

## API

### `POST /create-campaign`

Tworzy kampanię i zwraca dane dwóch kodów QR (publiczny i testowy).

**Body JSON**

```json
{
  "email": "owner@example.com",
  "maxScans": 10,
  "promotionType": "promo_code",
  "promoCode": "MEGA-2024",
  "cashierCode": "POS-42"
}
```

Polom warunkowym odpowiadają typy promocji:

- `redirect` wymaga pola `redirectUrl`,
- `promo_code` wymaga pola `promoCode`,
- `image` wymaga pola `imagePath` wskazującego obiekt w bucketcie (np. `kampania-1/kupon.png`).

**Odpowiedź 201**

```json
{
  "campaignId": "b63f41f3-a3fd-4e44-843a-4662bbadfb8d",
  "maxScans": 10,
  "promotionType": "promo_code",
  "publicQr": {
    "token": "3sD9fjKwPQaz",
    "url": "https://<ref>.functions.supabase.co/qr/3sD9fjKwPQaz",
    "dataUrl": "data:image/png;base64,iVBORw0KG..."
  },
  "testQr": {
    "token": "hYw2vH1o9QwE",
    "url": "https://<ref>.functions.supabase.co/qr/hYw2vH1o9QwE",
    "dataUrl": "data:image/png;base64,iVBORw0KG..."
  }
}
```

Jeżeli ustawiono Resend, na adres `email` zostanie wysłane podsumowanie z linkami.

### `POST /order`

Rejestruje zamówienie, uruchamia płatność Przelewy24 i – w przypadku BLIK – od razu
tworzy kampanię. Dla szybkich przelewów zwraca adres przekierowania.

**Body JSON**

```json
{
  "email": "owner@example.com",
  "maxScans": 150,
  "promotionType": "promo_code",
  "promoCode": "MEGA-2024",
  "price": 9.99,
  "extension": { "units": 0, "extraDays": 0, "extraCost": 0, "totalValidityDays": 49 },
  "payment": { "method": "blik", "code": "123456" }
}
```

- `payment.method` może przyjąć wartości `blik` lub `transfer`.
- W przypadku `transfer` pole `code` jest pomijane, a odpowiedź zawiera
  `payment.redirectUrl` (adres do przekierowania `trnRequest`).
- Pola kampanii są zgodne z `create-campaign`; dodatkowo przyjmujemy dane
  fakturowe (`invoiceRequested`, `invoiceDetails`) oraz `notes`.

**Odpowiedź 201 (BLIK)**

```json
{
  "status": "success",
  "order": {
    "id": "c5d0...",
    "sessionId": "7e7f...",
    "amount": 999,
    "currency": "PLN"
  },
  "payment": { "method": "blik", "orderId": 1234567 },
  "campaign": { "campaignId": "...", "publicQr": { "token": "..." } }
}
```

**Odpowiedź 202 (transfer)**

```json
{
  "status": "pending",
  "order": { "id": "...", "sessionId": "...", "amount": 999, "currency": "PLN" },
  "payment": {
    "method": "transfer",
    "orderId": 7654321,
    "redirectUrl": "https://sandbox.przelewy24.pl/trnRequest/..."
  }
}
```

### `GET /qr/{token}`

- Dla kampanii typu `redirect` (o ile limit nie został wyczerpany) wykonywane jest
  przekierowanie 302 na wskazany URL.
- Pozostałe typy renderują minimalistyczny widok HTML informujący o promocji,
  liczbie pozostałych użyć i ewentualnym kodzie kasowym.
- Token testowy nie zmniejsza licznika (`consume_campaign_scan` rozróżnia `is_test`).
- Po osiągnięciu limitu zwracany jest status HTTP 410 z komunikatem o zakończeniu.

## Zabezpieczenia

- Walidacja wejścia przy użyciu [Zod](https://github.com/colinhacks/zod).
- Wymagane `service_role` w Edge Functions – dostęp tylko z bezpiecznego środowiska.
- CORS kontrolowany przez zmienną `CORS_ALLOWED_ORIGIN`.
- Funkcja SQL `consume_campaign_scan` pracuje w transakcji, chroniąc licznik przed wyścigami.
- Brak cacheowania odpowiedzi widoku (`Cache-Control: no-store`).
- Grafiki w storage znajdują się w dedykowanym publicznym buckecie, co upraszcza obsługę.

## Kolejne kroki

- Panel www (np. Next.js) ułatwiający konfigurację i upload grafiki do bucketa.
- Automatyzacja płatności zgodna z modelem „mikro” (4–9 zł za kampanię).
- Rejestrowanie zdarzeń (Supabase Logs / Logflare) oraz dodatkowy monitoring.
