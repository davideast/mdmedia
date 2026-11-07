/**
 * Declarative server-side tool contract for Studio Contextual Chat.
 */

import type { Caller } from '@/lib/api-auth';
import type { ApiKeyScope } from '@/lib/api-key-token';
import type {
  ActiveViewContext,
  ChatResultPart,
  ClientActionPayload,
  SlashCommandId,
} from '@/lib/chat/types';

export type ToolExecutionPolicy =
  | 'auto-read'        // Fast, side-effect-free server read; auto-executed inside the SSE turn loop
  | 'client-immediate' // Reversible UI navigation/seek/prefill; emitted via SSE `client.action` & auto-continued
  | 'staged-confirm'   // Paid media generation or document mutation; validates & returns a Staged Action Card
  | 'immediate-write'; // Explicit low-cost write when confirmed

export interface ChatToolContext {
  caller: Caller;
  origin: string;
  threadId: string;
  messageId: string;
  callId: string;
  viewContext: ActiveViewContext | null;
  confirmedByUser: boolean;
  signal: AbortSignal;
}

export interface ChatToolOutcome<TOutput = Record<string, unknown>> {
  /** Compact structured JSON returned to Gemini in `FunctionResultStep.result`. */
  modelSummary: TOutput;
  /** Whether the tool call failed validation/execution (propagated to `FunctionResultStep.is_error`). */
  isError?: boolean;
  /** Rich UI primitives persisted on the assistant message and rendered in `ChatPanel`. */
  uiParts?: ChatResultPart[];
  /** Optional browser-side effect (open route, seek player, patch composer draft). */
  clientAction?: ClientActionPayload;
  /** Validated server parameters stored in `chatStagedActions/{callId}` when `policy === 'staged-confirm'`. */
  stagedPayload?: {
    validatedInput: Record<string, unknown>;
    targetRoute?: string | null;
  };
}

export interface ChatToolJsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface ChatToolDefinition<
  TInput = Record<string, unknown>,
  TOutput = Record<string, unknown>,
> {
  name: string;
  /** Human-readable progressive label while running, e.g. 'Reading document…' */
  runningLabel: string;
  kind: 'context' | 'action';
  policy: ToolExecutionPolicy;
  requiredScopes: readonly ApiKeyScope[];
  description: string;
  parameters: ChatToolJsonSchema;
  slashCommand?: SlashCommandId;
  execute: (input: TInput, ctx: ChatToolContext) => Promise<ChatToolOutcome<TOutput>>;
}
