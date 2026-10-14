import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The mdmedia agent skill, in the Agent Skills format (agentskills.io). The
 * repository's `.agents/skills/mdmedia` is the only copy; `mdmedia studio
 * install-skill` copies it into a skills directory, by default the
 * cross-client `~/.agents/skills`.
 */
export const SKILL_NAME = 'mdmedia';

/** The skill directory shipped with this package (src/remote → ../../.agents/skills/mdmedia; same from dist). */
export function skillSourceDir(): string {
  return fileURLToPath(new URL(`../../.agents/skills/${SKILL_NAME}`, import.meta.url));
}

/** Copies the skill into `<skillsDir>/mdmedia`, replacing an older copy. Returns the installed path. */
export function installSkill(skillsDir: string): string {
  const source = skillSourceDir();
  if (!fs.existsSync(`${source}/SKILL.md`)) throw new Error(`The mdmedia skill is missing from ${source}.`);
  const target = `${skillsDir}/${SKILL_NAME}`;
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  return target;
}
