// P-256 helpers for device signatures (verify) and APNs provider tokens
// (sign), on WebCrypto alone.

const STD_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

// Standard base64 with padding, which Swift's base64EncodedString() emits.
// Null for anything else, so a caller can name the field that was wrong.
export function fromBase64(s: string): Uint8Array | null {
  if (!STD_B64.test(s)) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// DER SubjectPublicKeyInfo of an uncompressed P-256 key: the algorithm
// identifier (id-ecPublicKey, prime256v1), a 66-byte BIT STRING header, 0x04.
const SPKI_P256_PREFIX = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
];

// The device's public key, or null when the bytes are not an uncompressed
// P-256 SPKI whose point is on the curve (importKey checks that).
export async function importDeviceKey(spkiB64: string): Promise<CryptoKey | null> {
  const der = fromBase64(spkiB64);
  if (!der || der.length !== 91 || SPKI_P256_PREFIX.some((b, i) => der[i] !== b)) return null;
  try {
    return await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return null;
  }
}

// SecKeyCreateSignature with .ecdsaSignatureMessageX962SHA256 returns
// DER: SEQUENCE { INTEGER r, INTEGER s }. WebCrypto verifies r‖s, each
// 32 bytes. Anything that is not minimal DER for two positive integers that
// fit in 32 bytes is refused, so one signature has one encoding.
export function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const out = new Uint8Array(64);
  let at = 2;
  for (const offset of [0, 32]) {
    if (der[at] !== 0x02) return null;
    const len = der[at + 1];
    const start = at + 2;
    if (len < 1 || len > 33 || start + len > der.length) return null;
    let v = der.subarray(start, start + len);
    // Negative, or a leading zero that wasn't needed.
    if (v[0] & 0x80) return null;
    if (v[0] === 0) {
      if (len === 1 || !(v[1] & 0x80)) return null;
      v = v.subarray(1);
    }
    if (v.length > 32) return null;
    out.set(v, offset + 32 - v.length);
    at = start + len;
  }
  return at === der.length ? out : null;
}

export async function verifyDer(key: CryptoKey, der: Uint8Array, message: string): Promise<boolean> {
  const raw = derToRaw(der);
  if (!raw) return false;
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, new TextEncoder().encode(message));
}

// The .p8 file Apple issues is a PKCS#8 PEM. Headers and whitespace are
// ignored, so the secret works pasted with or without newlines.
export async function importP8(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = fromBase64(body);
  if (!der) throw new Error("APNS_KEY_P8 is not a PEM private key");
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// A compact JWS (RFC 7515) with ES256. WebCrypto's ECDSA signature is already
// r‖s, the form JWS wants.
export async function es256Jwt(key: CryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)));
  return `${input}.${base64url(sig)}`;
}
