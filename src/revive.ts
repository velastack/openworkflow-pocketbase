import type {
  PaginatedResponse,
  StepAttempt,
  WorkflowRun,
} from "openworkflow/internal";

/**
 * Parse a nullable ISO-8601 timestamp string into a Date (or null).
 *
 * The velabase server emits timestamps as ISO-8601 strings with millisecond
 * precision and a `Z` suffix (matching `Date.prototype.toISOString()`); the
 * OpenWorkflow domain types use `Date`, so reviving only maps these strings.
 */
const d = (s: string | null | undefined): Date | null =>
  s == null ? null : new Date(s);

/**
 * Revive a wire workflow run into the domain {@link WorkflowRun}. Timestamps
 * become `Date`s; `config`/`context`/`input`/`output`/`error` are emitted by
 * the server as already-parsed JSON and pass through unchanged.
 */
export function reviveRun(r: any): WorkflowRun {
  return {
    ...r,
    availableAt: d(r.availableAt),
    deadlineAt: d(r.deadlineAt),
    startedAt: d(r.startedAt),
    finishedAt: d(r.finishedAt),
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

/**
 * Revive a wire step attempt into the domain {@link StepAttempt}.
 */
export function reviveStep(s: any): StepAttempt {
  return {
    ...s,
    startedAt: d(s.startedAt),
    finishedAt: d(s.finishedAt),
    createdAt: new Date(s.createdAt),
    updatedAt: new Date(s.updatedAt),
  };
}

/**
 * Revive a wire paginated list. The server's pagination envelope is already
 * the `{ next, prev }` shape the core expects; normalize missing keys to null.
 */
export function revivePaginated<T>(
  res: { data?: unknown[]; pagination?: { next?: string | null; prev?: string | null } },
  fn: (x: any) => T,
): PaginatedResponse<T> {
  return {
    data: (res.data ?? []).map(fn),
    pagination: {
      next: res.pagination?.next ?? null,
      prev: res.pagination?.prev ?? null,
    },
  };
}
