import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://garage:3900',
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:3900',
  region: process.env.STORAGE_REGION || 'garage',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
  bucket: process.env.STORAGE_BUCKET!,
  corsOrigins: (process.env.STORAGE_CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
}));
