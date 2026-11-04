import { runGuardrails, type Guardrail } from "./guardrail.js";

/**
 * Applies `afterText` guardrails to a stream without missing a match that is
 * split across chunks (for example "jane@exa" + "mple.com").
 *
 * Text is held back and released only up to the last whitespace that is
 * followed by a letter. Emails contain no whitespace, and phone numbers are
 * made of digits, spaces and + ( ) . - only, so neither can span such a point:
 * rewriting the released prefix gives the same result as rewriting the whole
 * text. The cost is a little latency: a word is released once the next word starts.
 *
 * If no boundary appears for `maxHoldChars` (e.g. a long code block), the
 * buffer is released anyway so the stream never stalls.
 */
export class StreamTextGuard {
  private buffer = "";
  findings = 0;

  constructor(
    private readonly guardrails: Guardrail[],
    private readonly maxHoldChars = 1024,
  ) {}

  /** Adds streamed text; returns the text that is now safe to send (may be ""). */
  push(text: string): string {
    this.buffer += text;
    const cut = this.buffer.length > this.maxHoldChars ? this.buffer.length : lastSafeBoundary(this.buffer);
    return this.release(cut);
  }

  /** At the end of the stream: releases whatever is still held. */
  flush(): string {
    return this.release(this.buffer.length);
  }

  private release(cut: number): string {
    if (cut === 0) return "";
    const ready = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    const outcome = runGuardrails(this.guardrails, "afterText", ready);
    this.findings += outcome.findings;
    return outcome.value;
  }
}

/** Index just after the last whitespace that is followed by a letter; 0 if none. */
function lastSafeBoundary(text: string): number {
  for (let i = text.length - 2; i >= 0; i--) {
    if (/\s/.test(text[i]!) && /\p{L}/u.test(text[i + 1]!)) return i + 1;
  }
  return 0;
}
