import type { ServerResponse } from "node:http";

/** Writes one Server-Sent Event: an `event:` line, a `data:` line and a blank line. */
export function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
