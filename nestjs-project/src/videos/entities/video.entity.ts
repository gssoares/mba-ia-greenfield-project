import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

const sizeBytesTransformer = {
  to: (value: number): number => value,
  from: (value: string): number => parseInt(value, 10),
};

@Entity('videos')
@Index(['processing_status', 'created_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Column({ type: 'uuid' })
  @Index()
  user_id: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  publication_status: string;

  @Column({ type: 'varchar', length: 16, default: 'uploading' })
  processing_status: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  failure_code: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'bigint', transformer: sizeBytesTransformer })
  size_bytes: number;

  @Column({ type: 'varchar', length: 255 })
  source_object_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  video_object_key: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_object_key: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 3, nullable: true })
  duration_seconds: string | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  upload_completed_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  @Index()
  failed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => User, (user) => user.videos)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
