import { randomBytes } from 'crypto';

export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}
