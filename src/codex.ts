import { Codex } from "@openai/codex-sdk";

export function createCodexClient(): Codex {
  return new Codex();
}
