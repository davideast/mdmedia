/** Shared by the operator CLI, authorization, request validation, and hydration. */
export const MAX_VOICE_NAME_LENGTH = 160;

/** @param {unknown} value @returns {value is string} */
export function isVoiceDisplayName(value) {
  return typeof value === 'string' && value.trim().length > 0 &&
    value.length <= MAX_VOICE_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}
