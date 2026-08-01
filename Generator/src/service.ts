import { ServiceError } from "../../packages/core/src/shared/errors.js";
import { objectValue } from "../../packages/core/src/shared/validation.js";
import { publicTokens, tokenize } from "../../packages/core/src/tokenization/tokenizer.js";
import { buildContributionPayload, type ContributionPayload } from "./builder.js";

export interface GeneratorOptions {
  publishUrl?: string;
  publishToken?: string;
  fetch?: typeof globalThis.fetch;
}

export class GeneratorService {
  readonly #publishUrl: string | undefined;
  readonly #publishToken: string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GeneratorOptions = {}) {
    this.#publishUrl = options.publishUrl?.replace(/\/$/u, "");
    this.#publishToken = options.publishToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  build(input: unknown): ContributionPayload {
    return buildContributionPayload(input);
  }

  tokenize(input: unknown): {
    tokenizer: "unilab-v1";
    offset_unit: "codepoint";
    tokens: Array<[number, number, number]>;
  } {
    const body = objectValue(input);
    if (typeof body.text !== "string" || body.text.length === 0 || body.text.length > 1_000_000) {
      throw new ServiceError(400, "INVALID_REQUEST");
    }
    return {
      tokenizer: "unilab-v1",
      offset_unit: "codepoint",
      tokens: publicTokens(tokenize(body.text)),
    };
  }

  async publish(input: unknown): Promise<{ alignment_id: number }> {
    if (this.#publishUrl === undefined || this.#publishToken === undefined) {
      throw new ServiceError(503, "MISCONFIGURED");
    }
    const payload = this.build(input);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#publishUrl}/v1/contribute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#publishToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ServiceError(502, "UPSTREAM_FAILED");
    }
    if (!response.ok) throw new ServiceError(502, "UPSTREAM_FAILED");
    let result: { alignment_id?: unknown };
    try {
      result = (await response.json()) as { alignment_id?: unknown };
    } catch {
      throw new ServiceError(502, "UPSTREAM_FAILED");
    }
    if (!Number.isSafeInteger(result.alignment_id)) {
      throw new ServiceError(502, "UPSTREAM_FAILED");
    }
    return { alignment_id: result.alignment_id as number };
  }
}
