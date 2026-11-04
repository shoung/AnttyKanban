import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function createOAuthSecrets() {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  return { state, verifier, challenge: hashValue(verifier) };
}

export interface TokenCipher {
  seal(value: string, owner: string): string;
  open(value: string, owner: string): string;
}

export function createCipher(base64Key: string): TokenCipher {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64Key) {
    throw new Error('Calendar encryption key must be exactly 32 bytes in canonical base64.');
  }
  const aad = (owner: string) => Buffer.from(`antty-calendar:v1:${owner}`);
  return {
    seal(value, owner) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(owner));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    open(value, owner) {
      const [version, encodedIv, encodedTag, encodedData, extra] = value.split('.');
      if (version !== 'v1' || !encodedIv || !encodedTag || !encodedData || extra !== undefined) {
        throw new Error('Invalid encrypted Calendar credential.');
      }
      const iv = Buffer.from(encodedIv, 'base64url');
      const tag = Buffer.from(encodedTag, 'base64url');
      if (iv.length !== 12 || tag.length !== 16)
        throw new Error('Invalid encrypted Calendar credential.');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad(owner));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(encodedData, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
