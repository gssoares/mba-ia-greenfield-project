import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FfmpegService } from './ffmpeg.service';

const exec = promisify(execCallback);

describe('FfmpegService (integration)', () => {
  let tempDir: string;
  let fixturePath: string;
  let ffmpegService: FfmpegService;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-service-'));
    fixturePath = path.join(tempDir, 'fixture.mp4');
    ffmpegService = new FfmpegService();

    await exec(
      `ffmpeg -y -f lavfi -i testsrc=duration=2:size=1280x720:rate=25 ` +
        `-f lavfi -i sine=frequency=1000:duration=2 ` +
        `-c:v libx264 -c:a aac -shortest "${fixturePath}"`,
    );
  }, 60000);

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('probes the fixture and returns format/stream fields', async () => {
    const probe = await ffmpegService.probe(fixturePath);

    expect(parseFloat(probe.format.duration ?? '0')).toBeCloseTo(2, 0);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    expect(videoStream?.codec_name).toBe('h264');
    expect(videoStream?.width).toBe(1280);
    expect(audioStream?.codec_name).toBe('aac');
  }, 30000);

  it('remuxes to a faststart MP4 with the moov atom before mdat', async () => {
    const outputPath = path.join(tempDir, 'remuxed.mp4');
    await ffmpegService.remuxFaststart(fixturePath, outputPath);

    const buffer = await fs.readFile(outputPath);
    const moovIndex = buffer.indexOf('moov');
    const mdatIndex = buffer.indexOf('mdat');
    expect(moovIndex).toBeGreaterThan(-1);
    expect(mdatIndex).toBeGreaterThan(-1);
    expect(moovIndex).toBeLessThan(mdatIndex);
  }, 30000);

  it('extracts a 1280px-wide JPEG thumbnail', async () => {
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');
    await ffmpegService.extractThumbnail(fixturePath, thumbnailPath, 1);

    const thumbnailProbe = await ffmpegService.probe(thumbnailPath);
    expect(thumbnailProbe.streams[0].width).toBe(1280);
  }, 30000);
});
