import { UnrecoverableError } from 'bullmq';
import { FfprobeResult } from './ffmpeg.service';

const SUPPORTED_VIDEO_CODEC = 'h264';
const SUPPORTED_AUDIO_CODEC = 'aac';

export function assertSupportedMedia(probe: FfprobeResult): void {
  const videoStream = probe.streams.find((s) => s.codec_type === 'video');
  if (!videoStream) {
    throw new UnrecoverableError('INVALID_MEDIA');
  }

  const audioStream = probe.streams.find((s) => s.codec_type === 'audio');

  if (
    videoStream.codec_name !== SUPPORTED_VIDEO_CODEC ||
    (audioStream && audioStream.codec_name !== SUPPORTED_AUDIO_CODEC)
  ) {
    throw new UnrecoverableError('UNSUPPORTED_CODEC');
  }
}

export function thumbnailTimestamp(durationSeconds: number): number {
  return Math.min(0.1 * durationSeconds, Math.max(durationSeconds - 0.1, 0));
}
