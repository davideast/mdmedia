import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-python";
import "prismjs/components/prism-css";
import "prismjs/components/prism-diff";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  typescript: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  console: "bash",
  py: "python",
  python: "python",
  json: "json",
  css: "css",
  html: "markup",
  xml: "markup",
  svg: "markup",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

/**
 * Applies minimal, quiet syntax highlighting to code using Prism.js.
 * Returns safe HTML with standard token spans.
 */
export function highlightCode(code: string, rawLang?: string): string {
  if (!code) return "";

  const normalizedLang = rawLang
    ? LANGUAGE_MAP[rawLang.toLowerCase().trim()] ?? rawLang.toLowerCase().trim()
    : null;

  let grammar = normalizedLang ? Prism.languages[normalizedLang] : undefined;
  let resolvedLang = normalizedLang;

  // Auto-detect common patterns if language is not explicitly provided
  if (!grammar) {
    if (
      /\b(const|let|var|function|import|export|require|console\.log|=>)\b/.test(code)
    ) {
      grammar = Prism.languages.javascript;
      resolvedLang = "javascript";
    } else if (
      /^\s*(#|\$|bin\/|npm |pnpm |bun |git |cd |curl |node )/m.test(code)
    ) {
      grammar = Prism.languages.bash;
      resolvedLang = "bash";
    }
  }

  if (grammar && resolvedLang) {
    try {
      return Prism.highlight(code, grammar, resolvedLang);
    } catch {
      return escapeHtml(code);
    }
  }

  return escapeHtml(code);
}
