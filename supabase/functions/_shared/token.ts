const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generateToken(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let token = "";
  for (let i = 0; i < bytes.length; i++) {
    token += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return token;
}
