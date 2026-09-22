import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { MediaUrlResponseDto } from './dto/media-url-response.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { SignUploadPartsResponseDto } from './dto/signed-upload-part.dto';
import { ListUploadedPartsResponseDto } from './dto/uploaded-part.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft owned by the caller and opens a multipart upload against object storage.',
  })
  @ApiBody({ type: CreateVideoUploadDto })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    type: VideoUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File size exceeds the 10 GiB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Content type is not among the accepted video formats',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoUploadDto,
  ): Promise<VideoUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':public_id/upload-parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Signs presigned PUT URLs for the requested part numbers, so the browser can upload bytes directly to storage.',
  })
  @ApiParam({ name: 'public_id', description: 'Video public ID' })
  @ApiBody({ type: SignUploadPartsDto })
  @ApiResponse({
    status: 200,
    description: 'Parts signed',
    type: SignUploadPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or a part number is out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The upload is not currently in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignUploadPartsResponseDto> {
    return this.videosService.signUploadParts(
      user.sub,
      publicId,
      dto.part_numbers,
    );
  }

  @Get(':public_id/upload-parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already stored for the in-progress multipart upload, so an interrupted upload can be resumed.',
  })
  @ApiParam({ name: 'public_id', description: 'Video public ID' })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts',
    type: ListUploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The upload is not currently in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<ListUploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(user.sub, publicId);
  }

  @Post(':public_id/upload-completion')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Closes the multipart upload in storage, verifies the final object size, transitions the video to processing and enqueues background processing.',
  })
  @ApiParam({ name: 'public_id', description: 'Video public ID' })
  @ApiBody({ type: CompleteUploadDto })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing enqueued',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The upload is not currently in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Uploaded parts do not match the expected upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto.parts);
  }

  @Get(':public_id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video status and metadata',
    description:
      'Returns the processing status and extracted metadata for a video owned by the caller.',
  })
  @ApiParam({ name: 'public_id', description: 'Video public ID' })
  @ApiResponse({
    status: 200,
    description: 'Video status and metadata',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedVideo(user.sub, publicId);
  }

  @Get(':public_id/playback-url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a signed playback URL',
    description:
      'Issues a short-lived signed URL for progressive playback of the processed video, served directly by object storage with Range support.',
  })
  @ApiParam({ name: 'public_id', description: 'Video public ID' })
  @ApiResponse({
    status: 200,
    description: 'Signed playback URL',
    type: MediaUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video has not finished processing yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPlaybackUrl(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<MediaUrlResponseDto> {
    return this.videosService.getPlaybackUrl(user.sub, publicId);
  }

  @Get(':public_id/download-url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a signed download URL',
    description:
      'Issues a short-lived signed URL to download the processed video as an attachment, served directly by object storage.',
  })
  @ApiParam({ name: 'public_id', description: 'Video public ID' })
  @ApiResponse({
    status: 200,
    description: 'Signed download URL',
    type: MediaUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video has not finished processing yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<MediaUrlResponseDto> {
    return this.videosService.getDownloadUrl(user.sub, publicId);
  }
}
