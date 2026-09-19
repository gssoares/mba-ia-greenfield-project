import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideosTable1789680630228 implements MigrationInterface {
  name = 'CreateVideosTable1789680630228';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(11) NOT NULL, "user_id" uuid NOT NULL, "publication_status" character varying(16) NOT NULL DEFAULT 'draft', "processing_status" character varying(16) NOT NULL DEFAULT 'uploading', "failure_code" character varying(64), "original_filename" character varying(255) NOT NULL, "content_type" character varying(100) NOT NULL, "size_bytes" bigint NOT NULL, "source_object_key" character varying(255) NOT NULL, "upload_id" character varying(255), "video_object_key" character varying(255), "thumbnail_object_key" character varying(255), "duration_seconds" numeric(10,3), "width" integer, "height" integer, "video_codec" character varying(32), "audio_codec" character varying(32), "upload_completed_at" TIMESTAMP WITH TIME ZONE, "processed_at" TIMESTAMP WITH TIME ZONE, "failed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_900733992fb36a6d855308c003" ON "videos" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_15db11c4887438ff38a5ec9e6d" ON "videos" ("failed_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ff5aae905a9f1c8b881e0bf1b8" ON "videos" ("processing_status", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_900733992fb36a6d855308c0039" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_900733992fb36a6d855308c0039"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ff5aae905a9f1c8b881e0bf1b8"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_15db11c4887438ff38a5ec9e6d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_900733992fb36a6d855308c003"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
  }
}
