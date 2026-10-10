import type { DenyReason } from "./types.js";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export class DenyError extends Error {
  readonly deny_reason: DenyReason;
  readonly detail: Record<string, unknown>;

  constructor(
    denyReason: DenyReason,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DenyError";
    this.deny_reason = denyReason;
    this.detail = detail;
  }
}
