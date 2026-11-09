// @deepseek-ai/dsh-llm comes from the DSH host at runtime and is not installed here.
// Only what node.ts uses.
declare module '@deepseek-ai/dsh-llm' {
  export interface ContentPart { type: string, text?: string, mediaType?: string, data?: string }
  export interface UserMessage { role: 'user', content: ContentPart[] }

  export function createUserMessage(init: { content: ContentPart[], source: { kind: string } }): UserMessage

  export class BlockAssembler {
    push(chunk: unknown): void
    blocks(): { type: string, text?: string }[]
    readonly finish: { kind: string, failure?: { message?: string } } | undefined
  }
}
