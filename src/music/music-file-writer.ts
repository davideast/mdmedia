import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface IMusicFileWriter {
  writeMusicFile(destinationPath: string, audioData: Uint8Array): Promise<void>;
}

export class NodeMusicFileWriter implements IMusicFileWriter {
  async writeMusicFile(destinationPath: string, audioData: Uint8Array): Promise<void> {
    const fullPath = resolve(destinationPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, audioData);
  }
}
