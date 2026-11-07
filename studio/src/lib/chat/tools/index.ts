/**
 * Unified declarative tool registry, scope filter, Gemini declaration builder,
 * and safe execution dispatcher for Studio Contextual Chat.
 */

import type { Interactions } from '@google/genai';
import { hasScope, type Caller } from '../../api-auth';
import { ACTION_TOOLS } from './action-tools';
import { CONTEXT_TOOLS } from './context-tools';
import type { ChatToolContext, ChatToolDefinition, ChatToolOutcome } from './types';

export { ACTION_TOOLS } from './action-tools';
export { CONTEXT_TOOLS } from './context-tools';
export * from './types';

export const CHAT_TOOLS: readonly ChatToolDefinition<any, any>[] = [
  ...CONTEXT_TOOLS,
  ...ACTION_TOOLS,
];

const TOOLS_BY_NAME = new Map<string, ChatToolDefinition<any, any>>(
  CHAT_TOOLS.map((tool) => [tool.name, tool]),
);

export function getChatTool(name: string | null | undefined): ChatToolDefinition<any, any> | null {
  if (!name) return null;
  return TOOLS_BY_NAME.get(name) ?? null;
}

export function getAllowedToolsForCaller(caller: Caller): ChatToolDefinition<any, any>[] {
  return CHAT_TOOLS.filter((tool) => tool.requiredScopes.every((scope) => hasScope(caller, scope)));
}

export function toGeminiFunctionDeclarations(
  tools: readonly ChatToolDefinition<any, any>[],
): Interactions.Function[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export async function executeChatToolCall(
  name: string,
  rawArgs: unknown,
  ctx: ChatToolContext,
): Promise<ChatToolOutcome<Record<string, unknown>>> {
  const tool = getChatTool(name);
  if (!tool) {
    return {
      isError: true,
      modelSummary: {
        error: 'unknown_tool',
        message: `Unknown tool "${name}".`,
      },
    };
  }

  for (const requiredScope of tool.requiredScopes) {
    if (!hasScope(ctx.caller, requiredScope)) {
      return {
        isError: true,
        modelSummary: {
          error: 'insufficient_scope',
          message: `This API key cannot ${requiredScope.replace(':', ' ')}.`,
        },
      };
    }
  }

  const normalizedArgs =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  try {
    return await tool.execute(normalizedArgs, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution failed.';
    const code =
      error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'tool_execution_error';
    return {
      isError: true,
      modelSummary: {
        error: code,
        message,
      },
    };
  }
}
