import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUser(): Promise<User> {
    return userRepository.save(
      userRepository.create({
        email: `video_entity_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
  }

  function baseVideoAttrs(userId: string, publicId: string) {
    return {
      public_id: publicId,
      user_id: userId,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 104857600,
      source_object_key: `videos/${publicId}/original`,
    };
  }

  it('should enforce the unique constraint on public_id', async () => {
    const user1 = await createUser();
    const user2 = await createUser();

    await videoRepository.save(
      videoRepository.create(baseVideoAttrs(user1.id, 'aaaaaaaaaaa')),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(baseVideoAttrs(user2.id, 'aaaaaaaaaaa')),
      ),
    ).rejects.toThrow();
  });

  it('should default publication_status to draft and processing_status to uploading', async () => {
    const user = await createUser();
    const saved = await videoRepository.save(
      videoRepository.create(baseVideoAttrs(user.id, 'bbbbbbbbbbb')),
    );

    expect(saved.publication_status).toBe('draft');
    expect(saved.processing_status).toBe('uploading');
  });

  it('should not return upload_id on a default query (select: false)', async () => {
    const user = await createUser();
    await videoRepository.save(
      videoRepository.create({
        ...baseVideoAttrs(user.id, 'ccccccccccc'),
        upload_id: 'some-multipart-upload-id',
      }),
    );

    const found = await videoRepository.findOne({
      where: { public_id: 'ccccccccccc' },
    });

    expect(found).toBeDefined();
    expect(found!.upload_id).toBeUndefined();
  });

  it('should require user_id', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'ddddddddddd',
          original_filename: 'clip.mp4',
          content_type: 'video/mp4',
          size_bytes: 104857600,
          source_object_key: 'videos/ddddddddddd/original',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related user via the ManyToOne relation', async () => {
    const user = await createUser();
    await videoRepository.save(
      videoRepository.create(baseVideoAttrs(user.id, 'eeeeeeeeeee')),
    );

    const found = await videoRepository.findOne({
      where: { public_id: 'eeeeeeeeeee' },
      relations: ['user'],
    });

    expect(found?.user.email).toBe(user.email);
  });
});
