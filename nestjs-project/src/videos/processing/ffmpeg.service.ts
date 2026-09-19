import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';

export class FfmpegCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly stderr: string,
  ) {
    super(`${command} exited with a non-zero status: ${stderr}`);
    this.name = 'FfmpegCommandError';
  }
}

export interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

export interface FfprobeResult {
  format: { duration?: string };
  streams: FfprobeStream[];
}

function run(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout });
      } else {
        reject(
          new FfmpegCommandError(`${command} ${args.join(' ')}`, stderr),
        );
      }
    });
  });
}

@Injectable()
export class FfmpegService {
  async probe(filePath: string): Promise<FfprobeResult> {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    return JSON.parse(stdout) as FfprobeResult;
  }

  async remuxFaststart(input: string, output: string): Promise<void> {
    await run('ffmpeg', [
      '-y',
      '-i',
      input,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output,
    ]);
  }

  async extractThumbnail(
    input: string,
    output: string,
    seconds: number,
  ): Promise<void> {
    await run('ffmpeg', [
      '-y',
      '-ss',
      String(seconds),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      'scale=1280:-2',
      output,
    ]);
  }
}
