import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY_ID: 'access-key-id',
  STORAGE_SECRET_ACCESS_KEY: 'secret-access-key',
  STORAGE_BUCKET: 'streamtube-videos',
  STORAGE_CORS_ORIGINS: 'http://localhost:3001',
  REDIS_HOST: 'redis',
};

const validate = (env: Record<string, string | undefined>) => {
  const result = envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );
  return {
    value: result.value as Record<string, unknown>,
    error: result.error,
  };
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — STORAGE_*', () => {
  it('should fail validation when STORAGE_BUCKET is missing, citing the key', () => {
    const { error } = validate({ STORAGE_BUCKET: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_BUCKET');
  });

  it('should fail validation when STORAGE_ACCESS_KEY_ID is missing, citing the key', () => {
    const { error } = validate({ STORAGE_ACCESS_KEY_ID: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY_ID');
  });

  it('should apply default endpoint, publicEndpoint and region when not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://garage:3900');
    expect(value.STORAGE_PUBLIC_ENDPOINT).toBe('http://localhost:3900');
    expect(value.STORAGE_REGION).toBe('garage');
  });
});

describe('envValidationSchema — REDIS_*', () => {
  it('should fail validation when REDIS_HOST is missing, citing the key', () => {
    const { error } = validate({ REDIS_HOST: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_HOST');
  });

  it('should apply default REDIS_PORT when not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_PORT).toBe(6379);
  });
});
