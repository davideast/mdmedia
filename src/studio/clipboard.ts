import { spawn } from 'node:child_process';

/**
 * Copies plain text to the operating system clipboard using native platform utilities
 * (pbcopy on macOS, wl-copy / xclip on Linux).
 */
export async function copyToSystemClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  return new Promise<boolean>((resolve) => {
    let command = 'pbcopy';
    let args: string[] = [];

    if (process.platform === 'linux') {
      if (process.env.WAYLAND_DISPLAY) {
        command = 'wl-copy';
      } else {
        command = 'xclip';
        args = ['-selection', 'clipboard'];
      }
    }

    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });

      child.on('error', () => {
        resolve(false);
      });

      child.on('close', (code) => {
        resolve(code === 0);
      });

      child.stdin.write(text);
      child.stdin.end();
    } catch {
      resolve(false);
    }
  });
}
