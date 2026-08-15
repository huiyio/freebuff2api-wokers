import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

const CIPHER = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';
const KEY_BYTES = 32;

export class CredentialVaultError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialVaultError';
  }
}

function decodeMasterKey(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new CredentialVaultError('ACCOUNT_STORE_KEY is required when the admin service is enabled');
  }

  let key;
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    key = Buffer.from(text, 'hex');
  } else if (/^[A-Za-z0-9_-]{43}$/.test(text)) {
    const decoded = Buffer.from(text, 'base64url');
    key = decoded.toString('base64url') === text ? decoded : null;
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new CredentialVaultError('ACCOUNT_STORE_KEY must be 32 bytes encoded as 64 hex characters or base64url');
  }
  return key;
}

function encodePart(value) {
  return Buffer.from(value).toString('base64url');
}

function decodePart(value) {
  return Buffer.from(value, 'base64url');
}

export function createCredentialVault(masterKey) {
  const key = decodeMasterKey(masterKey);

  return Object.freeze({
    encrypt(value, associatedData) {
      if (typeof value !== 'string') throw new CredentialVaultError('credential value must be a string');
      const iv = randomBytes(12);
      const cipher = createCipheriv(CIPHER, key, iv);
      cipher.setAAD(Buffer.from(String(associatedData), 'utf8'));
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [FORMAT_VERSION, encodePart(iv), encodePart(tag), encodePart(encrypted)].join('.');
    },

    decrypt(value, associatedData) {
      try {
        const [version, ivPart, tagPart, encryptedPart, extra] = String(value || '').split('.');
        if (version !== FORMAT_VERSION || !ivPart || !tagPart || encryptedPart === undefined || extra !== undefined) {
          throw new Error('unsupported encrypted value');
        }
        const decipher = createDecipheriv(CIPHER, key, decodePart(ivPart));
        decipher.setAAD(Buffer.from(String(associatedData), 'utf8'));
        decipher.setAuthTag(decodePart(tagPart));
        return Buffer.concat([
          decipher.update(decodePart(encryptedPart)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new CredentialVaultError('encrypted credentials cannot be decrypted with ACCOUNT_STORE_KEY');
      }
    },

    fingerprint(namespace, value) {
      return createHmac('sha256', key)
        .update(String(namespace))
        .update('\0')
        .update(String(value))
        .digest('hex');
    },
  });
}

export function maskProxyUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const auth = url.username || url.password ? '***@' : '';
    const hostname = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
    return `${url.protocol}//${auth}${hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return 'configured';
  }
}

export function proxyProtocol(value) {
  if (!value) return null;
  try {
    const protocol = new URL(value).protocol.replace(':', '');
    return protocol === 'socks5h' ? 'socks5' : protocol;
  } catch {
    return null;
  }
}
