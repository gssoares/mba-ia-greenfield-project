import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  GetObjectCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

@Injectable()
export class StorageService implements OnModuleInit {
  readonly client: S3Client;
  readonly publicClient: S3Client;
  readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;

    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };

    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials,
      // Garage rejects the default flexible-checksum placeholder baked into
      // presigned URLs by WHEN_SUPPORTED; UploadPart/GetObject don't require
      // a checksum, so WHEN_REQUIRED keeps the SDK from adding one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });

    this.publicClient = new S3Client({
      endpoint: config.publicEndpoint,
      region: config.region,
      forcePathStyle: true,
      credentials,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: this.config.corsOrigins,
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
            },
          ],
        },
      }),
    );

    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'abort-incomplete-multipart',
              Status: 'Enabled',
              Filter: { Prefix: '' },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
          ],
        },
      }),
    );
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async presignGetObject(
    key: string,
    expiresInSeconds: number,
    contentDisposition?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition,
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}
