import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The daemons synthesize WAV; the catalog's audio artifact format is mp3.
// ffmpeg is already a hard dependency of the local service (audio ingest), so
// the worker leans on the same binary rather than adding an encoder library.
export async function transcodeWavToMp3(inputPath, outputPath, { execImpl = execFileAsync } = {}) {
  try {
    await execImpl('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-codec:a', 'libmp3lame',
      '-qscale:a', '2',
      outputPath,
    ]);
  } catch (error) {
    throw new Error(`ffmpeg mp3 transcode failed: ${error.stderr?.toString().slice(-400) || error.message}`, { cause: error });
  }
  return outputPath;
}

// Decoded input duration is the worker-side billing enforcement signal for
// STT: the socket cannot measure uploaded audio, so the worker refuses jobs
// whose real duration materially exceeds the client's declared (billed) one.
export async function probeDurationSeconds(path, { execImpl = execFileAsync } = {}) {
  let stdout;
  try {
    ({ stdout } = await execImpl('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path,
    ]));
  } catch (error) {
    throw new Error(`ffprobe failed: ${error.stderr?.toString().slice(-400) || error.message}`, { cause: error });
  }
  const seconds = Number(String(stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned no duration for ${path}`);
  }
  return seconds;
}

// STT test jobs arrive with no uploaded asset (the tier validator exempts
// them); the worker proves the full pipeline against a generated clip instead.
export async function synthesizeTestClip(outputPath, { seconds = 2, execImpl = execFileAsync } = {}) {
  try {
    await execImpl('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${seconds}`,
      '-ar', '16000',
      '-ac', '1',
      outputPath,
    ]);
  } catch (error) {
    throw new Error(`ffmpeg test clip synthesis failed: ${error.stderr?.toString().slice(-400) || error.message}`, { cause: error });
  }
  return outputPath;
}
