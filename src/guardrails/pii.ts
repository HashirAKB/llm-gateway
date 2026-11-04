import type { MessagesRequest } from "../api.js";
import type { Guardrail, GuardrailOutcome } from "./guardrail.js";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Phone numbers are found in two steps, which keeps the regex readable:
 * 1. find runs of digits that may contain spaces, dots, dashes, brackets, and a leading +,
 * 2. keep only runs with 10 to 15 digits (the E.164 range), so years, prices and
 *    order numbers are left alone.
 */
const PHONE_CANDIDATE = /\+?\(?\d[\d\s().-]{7,}\d/g;

function isPhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "").length;
  return digits >= 10 && digits <= 15;
}

/** Replaces emails with [EMAIL] and phone numbers with [PHONE]. */
export function redactPii(text: string): { text: string; count: number } {
  let count = 0;
  const withoutEmails = text.replace(EMAIL, () => {
    count++;
    return "[EMAIL]";
  });
  const redacted = withoutEmails.replace(PHONE_CANDIDATE, (match) => {
    if (!isPhone(match)) return match;
    count++;
    return "[PHONE]";
  });
  return { text: redacted, count };
}

/**
 * Redacts PII from the prompt (system and messages) before it leaves the
 * gateway. Regexes are a baseline, not a guarantee: they miss PII written in
 * unusual formats and cannot catch names or addresses.
 */
export class PiiRedactionGuardrail implements Guardrail {
  readonly name = "pii-redaction";

  before(req: MessagesRequest): GuardrailOutcome<MessagesRequest> {
    let findings = 0;
    const redact = (text: string) => {
      const result = redactPii(text);
      findings += result.count;
      return result.text;
    };
    const value = {
      ...req,
      system: req.system === undefined ? undefined : redact(req.system),
      messages: req.messages.map((m) => ({ ...m, content: redact(m.content) })),
    };
    return { value, findings };
  }
}
