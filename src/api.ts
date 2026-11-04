import { z } from "zod";

/**
 * The public request shape for POST /v1/messages.
 * A deliberately small subset of the Anthropic Messages API: text-only messages.
 */
export const MessagesRequestSchema = z.object({
  /** A route alias from config, e.g. "fast" or "smart". */
  model: z.string().min(1),
  system: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
  max_tokens: z.number().int().positive().max(128_000),
  temperature: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
});

export type MessagesRequest = z.infer<typeof MessagesRequestSchema>;
export type ChatMessage = MessagesRequest["messages"][number];

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** The JSON body returned for a non-streaming request. */
export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: { type: "text"; text: string }[];
  stop_reason: string;
  usage: Usage;
}
