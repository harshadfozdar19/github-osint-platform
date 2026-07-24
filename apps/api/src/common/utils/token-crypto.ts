import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

/**
 * AES-256-GCM at-rest encryption for user-supplied credentials (e.g. a
 * workspace's own GitHub token). GCM is authenticated: tampering with the
 * ciphertext, IV, or auth tag (e.g. a raw DB edit) causes decryption to throw
 * rather than silently returning garbage. The master key never touches the
 * database — it lives only in server env (TOKEN_ENCRYPTION_KEY) — so reading
 * the DB directly (a backup, a dump, an attacker with only DB access) never
 * yields the plaintext token by itself.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Normalizes any-length key material into the exact 32 bytes AES-256 needs. */
function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey).digest();
}

export function encryptSecret(
  plaintext: string,
  masterKey: string,
): EncryptedPayload {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/** Throws if the ciphertext/IV/auth tag were tampered with or the key is wrong. */
export function decryptSecret(
  payload: EncryptedPayload,
  masterKey: string,
): string {
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Last 4 characters only — enough for a user to recognize their own token, no more. */
export function maskToken(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 4) return '****';
  return trimmed.slice(-4);
}
