import { UnrecoverableError } from 'bullmq';
import { FfprobeResult, FfprobeStream } from './ffmpeg.service';
import { assertSupportedMedia, thumbnailTimestamp } from './media-policy';

function probeWith(streams: FfprobeStream[]): FfprobeResult {
  return { format: {}, streams };
}

describe('assertSupportedMedia', () => {
  it('should throw UnrecoverableError with INVALID_MEDIA when there is no readable video stream', () => {
    expect(() =>
      assertSupportedMedia(
        probeWith([{ codec_type: 'audio', codec_name: 'aac' }]),
      ),
    ).toThrow(UnrecoverableError);

    expect.assertions(3);
    try {
      assertSupportedMedia(probeWith([]));
    } catch (err) {
      expect(err).toBeInstanceOf(UnrecoverableError);
      expect((err as Error).message).toBe('INVALID_MEDIA');
    }
  });

  it('should throw UnrecoverableError with UNSUPPORTED_CODEC for a vp9 video stream', () => {
    expect.assertions(2);
    try {
      assertSupportedMedia(
        probeWith([{ codec_type: 'video', codec_name: 'vp9' }]),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(UnrecoverableError);
      expect((err as Error).message).toBe('UNSUPPORTED_CODEC');
    }
  });

  it('should throw UnrecoverableError with UNSUPPORTED_CODEC for opus audio', () => {
    expect.assertions(2);
    try {
      assertSupportedMedia(
        probeWith([
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'opus' },
        ]),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(UnrecoverableError);
      expect((err as Error).message).toBe('UNSUPPORTED_CODEC');
    }
  });

  it('should accept h264 video with aac audio', () => {
    expect(() =>
      assertSupportedMedia(
        probeWith([
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'aac' },
        ]),
      ),
    ).not.toThrow();
  });

  it('should accept h264 video with no audio stream', () => {
    expect(() =>
      assertSupportedMedia(
        probeWith([{ codec_type: 'video', codec_name: 'h264' }]),
      ),
    ).not.toThrow();
  });
});

describe('thumbnailTimestamp', () => {
  it('should return 10% of the duration for a typical video', () => {
    expect(thumbnailTimestamp(100)).toBeCloseTo(10);
  });

  it('should clamp to duration - 0.1 when that is smaller than 10% of duration', () => {
    // duration=0.105: 10% = 0.0105; duration - 0.1 = 0.005 -> the smaller wins
    expect(thumbnailTimestamp(0.105)).toBeCloseTo(0.005, 5);
  });

  it('should never go below 0 for extremely short videos', () => {
    expect(thumbnailTimestamp(0.05)).toBe(0);
  });
});
