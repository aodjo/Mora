import { ServiceError } from "./errors.js";
import type { AlignmentSource, IndexedTimeSpan, TimeSpan } from "./types.js";

export function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, options: { min?: number; max?: number } = {}): string {
  if (typeof value !== "string") throw new ServiceError(400, "INVALID_REQUEST");
  const min = options.min ?? 1;
  const max = options.max ?? 10_000;
  if (value.length < min || value.length > max) throw new ServiceError(400, "INVALID_REQUEST");
  return value;
}

export function optionalString(value: unknown, max = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, { max });
}

export function optionalInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  return value as number;
}

export function normalizeIsrc(value: unknown): string {
  const normalized = requiredString(value, { max: 15 }).replaceAll("-", "").toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized)) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  return normalized;
}

export function normalizeMbid(value: unknown): string {
  const normalized = requiredString(value, { max: 36 }).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  return normalized;
}

export function alignmentSource(value: unknown): AlignmentSource {
  if (value !== "manual" && value !== "forced-align") {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  return value;
}

export function timeSpans(value: unknown): TimeSpan[] {
  if (!Array.isArray(value)) throw new ServiceError(400, "INVALID_REQUEST");
  return value.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 2) throw new ServiceError(400, "INVALID_REQUEST");
    const [start, end] = raw;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new ServiceError(400, "INVALID_REQUEST");
    }
    return [start, end];
  });
}

export function indexedTimeSpans(value: unknown): IndexedTimeSpan[] {
  if (!Array.isArray(value)) throw new ServiceError(400, "INVALID_REQUEST");
  const seen = new Set<number>();
  const result = value.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 3) throw new ServiceError(400, "INVALID_REQUEST");
    const [index, start, end] = raw;
    if (
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      index < 0 ||
      start < 0 ||
      end < start ||
      seen.has(index)
    ) {
      throw new ServiceError(400, "INVALID_REQUEST");
    }
    seen.add(index);
    return [index, start, end] as IndexedTimeSpan;
  });
  return result.sort((left, right) => left[0] - right[0]);
}
