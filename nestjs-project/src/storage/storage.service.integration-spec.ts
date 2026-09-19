import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  HeadObjectCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

function createTestStorageService(): StorageService {
  const config = {
    ...storageConfig(),
    // Proves presigned URLs are signed for, and reachable via, a host
    // distinct from the internal Compose service name (TD-02 safety net).
    publicEndpoint: 'http://host.docker.internal:3900',
  };
  return new StorageService(config);
}

describe('StorageService (integration)', () => {
  let storageService: StorageService;

  beforeAll(() => {
    storageService = createTestStorageService();
  });

  describe('multipart upload flow', () => {
    it('supports the full create → sign → PUT → list → complete → head flow against real Garage storage', async () => {
      const key = `videos/test-${Date.now()}/original`;

      const { UploadId } = await storageService.client.send(
        new CreateMultipartUploadCommand({
          Bucket: storageService.bucket,
          Key: key,
          ContentType: 'video/mp4',
        }),
      );
      expect(UploadId).toBeDefined();

      const partUrl = await storageService.presignUploadPart(
        key,
        UploadId!,
        1,
        3600,
      );
      expect(new URL(partUrl).host).toBe('host.docker.internal:3900');

      const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');
      const putResponse = await fetch(partUrl, {
        method: 'PUT',
        body: partBody,
      });
      expect(putResponse.status).toBe(200);
      const etag = putResponse.headers.get('etag');
      expect(etag).toBeTruthy();

      const { Parts } = await storageService.client.send(
        new ListPartsCommand({
          Bucket: storageService.bucket,
          Key: key,
          UploadId,
        }),
      );
      expect(Parts).toHaveLength(1);
      expect(Parts![0].PartNumber).toBe(1);
      expect(Parts![0].Size).toBe(partBody.length);

      await storageService.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: storageService.bucket,
          Key: key,
          UploadId,
          MultipartUpload: {
            Parts: [{ ETag: etag!, PartNumber: 1 }],
          },
        }),
      );

      const head = await storageService.client.send(
        new HeadObjectCommand({ Bucket: storageService.bucket, Key: key }),
      );
      expect(head.ContentLength).toBe(partBody.length);
    }, 30000);

    it('aborts an unfinished multipart upload cleanly', async () => {
      const key = `videos/test-abort-${Date.now()}/original`;
      const { UploadId } = await storageService.client.send(
        new CreateMultipartUploadCommand({
          Bucket: storageService.bucket,
          Key: key,
          ContentType: 'video/mp4',
        }),
      );

      await expect(
        storageService.client.send(
          new AbortMultipartUploadCommand({
            Bucket: storageService.bucket,
            Key: key,
            UploadId,
          }),
        ),
      ).resolves.toBeDefined();
    }, 30000);
  });

  describe('bucket bootstrap (CORS + lifecycle)', () => {
    beforeAll(async () => {
      await storageService.onModuleInit();
    });

    it('exposes ETag via bucket CORS for the configured origins', async () => {
      const { CORSRules } = await storageService.client.send(
        new GetBucketCorsCommand({ Bucket: storageService.bucket }),
      );
      expect(CORSRules).toHaveLength(1);
      expect(CORSRules![0].AllowedOrigins).toEqual(
        expect.arrayContaining(['http://localhost:3001']),
      );
      expect(CORSRules![0].ExposeHeaders).toEqual(
        expect.arrayContaining(['ETag']),
      );
    });

    it('configures the abort-incomplete-multipart lifecycle rule with a 1 day retention', async () => {
      const { Rules } = await storageService.client.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: storageService.bucket,
        }),
      );
      const rule = Rules!.find((r) => r.ID === 'abort-incomplete-multipart');
      expect(rule).toBeDefined();
      expect(rule!.AbortIncompleteMultipartUpload?.DaysAfterInitiation).toBe(
        1,
      );
    });

    it('re-applying the bucket bootstrap does not duplicate or break the configuration', async () => {
      await expect(storageService.onModuleInit()).resolves.not.toThrow();

      const { CORSRules } = await storageService.client.send(
        new GetBucketCorsCommand({ Bucket: storageService.bucket }),
      );
      expect(CORSRules).toHaveLength(1);
    });
  });

  describe('presignGetObject', () => {
    it('passes the received expiresInSeconds through to the signed URL', async () => {
      const url = await storageService.presignGetObject(
        'videos/some-key/video.mp4',
        900,
      );
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('900');
    });
  });
});
