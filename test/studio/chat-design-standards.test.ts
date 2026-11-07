import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CHAT_COMPONENTS_DIR = "studio/src/components/chat";

function collectChatSourceFiles(entryPath: string): string[] {
  const abs = join(REPO_ROOT, entryPath);
  if (!existsSync(abs)) return [];
  const stat = statSync(abs);
  if (stat.isFile()) return [abs];
  const results: string[] = [];
  for (const child of readdirSync(abs)) {
    const childRel = join(entryPath, child);
    const childAbs = join(REPO_ROOT, childRel);
    const childStat = statSync(childAbs);
    if (childStat.isDirectory()) {
      results.push(...collectChatSourceFiles(childRel));
    } else if (child.endsWith(".ts") || child.endsWith(".tsx")) {
      results.push(childAbs);
    }
  }
  return results;
}

describe("Studio Contextual Chat UI Design Standards", () => {
  it("scans all chat components and enforces zero margins, zero one-sided padding nudges, zero spin/pulse animations, zero dangerouslySetInnerHTML, and zero JSX actions props", () => {
    const files = collectChatSourceFiles(CHAT_COMPONENTS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(9);

    const violations: string[] = [];

    const marginTokenRegex =
      /\b(?:-?m[xytrblse]?-(?:\d+|px|auto|\[[^\]]+\])|space-[xy]-(?:\d+|px|reverse|\[[^\]]+\]))\b/;
    const oneSidedPaddingRegex = /\bp[trblse]-(?:\d+|px|\[[^\]]+\])\b/;
    const inlineNudgeStyleRegex =
      /\b(?:paddingLeft|paddingRight|paddingTop|paddingBottom|margin|marginLeft|marginRight|marginTop|marginBottom)\s*:/;
    const noisyAnimationRegex = /\b(?:animate-ping|animate-pulse|animate-spin)\b/;
    const jsxActionsPropRegex = /\bactions=\{\s*</;

    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");

      lines.forEach((line, index) => {
        const lineNo = index + 1;
        if (marginTokenRegex.test(line)) {
          violations.push(
            `${rel}:${lineNo} uses forbidden margin or space utility: ${line.trim()}`,
          );
        }
        if (oneSidedPaddingRegex.test(line) || inlineNudgeStyleRegex.test(line)) {
          violations.push(
            `${rel}:${lineNo} uses forbidden one-sided padding or inline nudge style: ${line.trim()}`,
          );
        }
        if (noisyAnimationRegex.test(line)) {
          violations.push(
            `${rel}:${lineNo} uses forbidden ping/pulse/spin animation: ${line.trim()}`,
          );
        }
        if (line.includes("dangerouslySetInnerHTML")) {
          violations.push(
            `${rel}:${lineNo} uses forbidden dangerouslySetInnerHTML: ${line.trim()}`,
          );
        }
        if (jsxActionsPropRegex.test(line)) {
          violations.push(
            `${rel}:${lineNo} passes raw JSX to an actions prop: ${line.trim()}`,
          );
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
