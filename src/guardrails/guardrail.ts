import type { MessagesRequest } from "../api.js";

export interface GuardrailOutcome<T> {
  value: T;
  /** How many things the guardrail changed or flagged (e.g. redactions). */
  findings: number;
}

/**
 * A pluggable check that runs around the provider call.
 * - `before` runs on the request, before the cache lookup and the provider.
 *   It may rewrite the request, or throw a GatewayError to block it.
 * - `afterText` rewrites reply text, for JSON replies and for streams.
 *   For streams it receives text in pieces that end at a "whitespace then letter"
 *   boundary (see StreamTextGuard), so a pattern it rewrites must not span one.
 */
export interface Guardrail {
  readonly name: string;
  before?(req: MessagesRequest): GuardrailOutcome<MessagesRequest>;
  afterText?(text: string): GuardrailOutcome<string>;
}

/** Runs one phase of every guardrail in order, threading the value through. */
export function runGuardrails<T>(
  guardrails: Guardrail[],
  phase: "before" | "afterText",
  value: T,
): GuardrailOutcome<T> {
  let findings = 0;
  for (const guardrail of guardrails) {
    const hook = guardrail[phase] as ((v: T) => GuardrailOutcome<T>) | undefined;
    if (!hook) continue;
    const outcome = hook.call(guardrail, value);
    value = outcome.value;
    findings += outcome.findings;
  }
  return { value, findings };
}
