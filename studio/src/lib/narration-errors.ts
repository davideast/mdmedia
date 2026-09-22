export type NarrationErrorCategory =
  | "policy"
  | "quota"
  | "config"
  | "invalid_input"
  | "transient"
  | "system";

export interface ClassifiedNarrationError {
  code: string;
  category: NarrationErrorCategory;
  message: string;
  actionableHint?: string;
  chunkIndex?: number;
  retryable: boolean;
}

export interface NarrationErrorContext {
  currentChunkIndex?: number;
  promptStyle?: string;
}

const POLICY_KEYWORDS = [
  "prohibited_content",
  "prohibited use policy",
  "input blocked",
  "sensitive words",
  "violate google's",
  "harm_category",
  "safety policy",
  "finish_reason: safety",
  "blocked by safety",
];

const QUOTA_KEYWORDS = [
  "resource_exhausted",
  "quota exceeded",
  "rate limit",
  "too many requests",
];

const AUTH_KEYWORDS = [
  "gemini_api_key",
  "api_key_invalid",
  "api key not valid",
  "unauthorized",
  "forbidden",
];

const TRANSIENT_KEYWORDS = [
  "econnreset",
  "etimedout",
  "fetch failed",
  "eai_again",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
];

/**
 * Inspects any raw error from the TTS provider, pipeline, or Gemini API
 * and maps it to a structured, user-actionable error object.
 */
export function classifyNarrationError(
  error: unknown,
  context?: NarrationErrorContext
): ClassifiedNarrationError {
  const errObj = error as any;
  const status = Number(errObj?.status ?? errObj?.statusCode ?? 0);
  const rawCode = String(errObj?.error?.code ?? errObj?.code ?? "").toLowerCase();
  const rawMessage = String(
    errObj?.error?.message ??
      errObj?.message ??
      errObj?.body ??
      (error instanceof Error ? error.message : String(error))
  );
  const lowerMessage = rawMessage.toLowerCase();

  const chunkIndex = context?.currentChunkIndex;
  const paragraphLabel = chunkIndex !== undefined ? `paragraph ${chunkIndex + 1}` : "this section";

  // 1. Content Policy / Safety Filter Violations
  const isPolicy =
    rawCode === "prohibited_content" ||
    rawCode === "safety" ||
    POLICY_KEYWORDS.some((kw) => lowerMessage.includes(kw) || rawCode.includes(kw));

  if (isPolicy || (status === 400 && lowerMessage.includes("blocked"))) {
    return {
      code: "CONTENT_POLICY_VIOLATION",
      category: "policy",
      message: `Content blocked: Sensitive words violate Generative AI safety guidelines in ${paragraphLabel}.`,
      actionableHint: context?.promptStyle?.trim()
        ? `Review ${paragraphLabel} and your custom delivery instructions for sensitive, aggressive, or security-related words.`
        : `Review ${paragraphLabel} for sensitive or security-related words and try rephrasing.`,
      chunkIndex,
      retryable: false,
    };
  }

  // 2. Quota / Rate Limiting (429)
  const isQuota =
    status === 429 ||
    rawCode === "resource_exhausted" ||
    QUOTA_KEYWORDS.some((kw) => lowerMessage.includes(kw) || rawCode.includes(kw));

  if (isQuota) {
    return {
      code: "RATE_LIMIT_EXCEEDED",
      category: "quota",
      message: "API rate limit or quota exceeded during synthesis.",
      actionableHint: "Wait a moment before retrying. If this continues, check your API quota limits.",
      chunkIndex,
      retryable: true,
    };
  }

  // 3. Authentication / Key Configuration (401 / 403)
  const isAuth =
    status === 401 ||
    status === 403 ||
    AUTH_KEYWORDS.some((kw) => lowerMessage.includes(kw) || rawCode.includes(kw));

  if (isAuth) {
    return {
      code: "AUTH_CONFIG_ERROR",
      category: "config",
      message: "Narration is temporarily unavailable due to an API configuration error.",
      actionableHint: "Verify that your Gemini API key is valid and has permissions enabled.",
      chunkIndex,
      retryable: false,
    };
  }

  // 4. Empty Source Markdown
  if (lowerMessage.includes("nothing to narrate") || rawCode === "empty_source") {
    return {
      code: "EMPTY_SOURCE",
      category: "invalid_input",
      message: "There was nothing to narrate in this document.",
      actionableHint: "Add some speakable text to your document and try again.",
      retryable: false,
    };
  }

  // 5. Upstream Service Unavailable / Network Timeouts (5xx)
  const isTransient =
    (status >= 500 && status < 600) ||
    TRANSIENT_KEYWORDS.some((kw) => lowerMessage.includes(kw));

  if (isTransient) {
    return {
      code: "UPSTREAM_UNAVAILABLE",
      category: "transient",
      message: "The AI narration service is temporarily unavailable.",
      actionableHint: "This is usually a temporary upstream glitch. Please try again shortly.",
      chunkIndex,
      retryable: true,
    };
  }

  // 6. Generic Fallback
  return {
    code: "INTERNAL_ERROR",
    category: "system",
    message: "Something went wrong while creating this narration.",
    actionableHint: "Please try again. If the issue persists, check your input format.",
    chunkIndex,
    retryable: false,
  };
}
