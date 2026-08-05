import { safeStorage } from 'electron';

export function encryptKey(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(plain, 'utf8').toString('base64');
  return safeStorage.encryptString(plain).toString('base64');
}

export function decryptKey(encryptedB64: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(encryptedB64, 'base64').toString('utf8');
  }
  return safeStorage.decryptString(Buffer.from(encryptedB64, 'base64'));
}
