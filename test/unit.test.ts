import { describe, expect, test, vi } from "vitest";
import { ClientResponseError } from "pocketbase";
import { BackendPocketBase } from "../src/index.js";
import { reviveRun, revivePaginated } from "../src/revive.js";

/** A minimal valid wire workflow run (ISO timestamps) for revive paths. */
function runWire(overrides: Record<string, unknown> = {}) {
  return {
    namespaceId: "ns",
    id: "run-1",
    workflowName: "wf",
    version: null,
    status: "running",
    idempotencyKey: null,
    config: {},
    context: null,
    input: null,
    output: null,
    error: null,
    attempts: 1,
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    workerId: "w",
    availableAt: "2026-06-02T14:30:45.123Z",
    deadlineAt: null,
    startedAt: "2026-06-02T14:30:45.000Z",
    finishedAt: null,
    createdAt: "2026-06-02T14:30:45.000Z",
    updatedAt: "2026-06-02T14:30:46.000Z",
    ...overrides,
  };
}

/** Build a mock pocketbase-sveltekit client around a `send` implementation. */
function mockClient(send: (url: string, opts: any) => Promise<any>) {
  const authRefresh = vi.fn(async () => ({}));
  const authWithPassword = vi.fn(async () => ({}));
  const client = {
    autoCancellation: vi.fn(),
    authStore: { isValid: true },
    collection: vi.fn(() => ({ authRefresh, authWithPassword })),
    send: vi.fn(send),
  };
  return { client: client as any, authRefresh, authWithPassword };
}

describe("revive", () => {
  test("reviveRun maps timestamps to Date and passes JSON through", () => {
    const r = reviveRun(runWire({ config: { a: 1 }, error: { message: "x" } }));
    expect(r.availableAt).toBeInstanceOf(Date);
    expect(r.availableAt?.toISOString()).toBe("2026-06-02T14:30:45.123Z");
    expect(r.startedAt).toBeInstanceOf(Date);
    expect(r.deadlineAt).toBeNull();
    expect(r.finishedAt).toBeNull();
    expect(r.createdAt).toBeInstanceOf(Date);
    expect(r.updatedAt).toBeInstanceOf(Date);
    expect(r.config).toEqual({ a: 1 });
    expect(r.error).toEqual({ message: "x" });
  });

  test("revivePaginated normalizes missing data/pagination", () => {
    const res = revivePaginated({}, reviveRun);
    expect(res.data).toEqual([]);
    expect(res.pagination).toEqual({ next: null, prev: null });
  });

  test("revivePaginated maps rows and preserves cursors", () => {
    const res = revivePaginated(
      { data: [runWire(), runWire({ id: "run-2" })], pagination: { next: "c", prev: null } },
      reviveRun,
    );
    expect(res.data.map((r) => r.id)).toEqual(["run-1", "run-2"]);
    expect(res.data[0]?.createdAt).toBeInstanceOf(Date);
    expect(res.pagination).toEqual({ next: "c", prev: null });
  });
});

describe("soft-null reads", () => {
  test("getWorkflowRun returns null on {run:null}", async () => {
    const { client } = mockClient(async () => ({ run: null }));
    const backend = new BackendPocketBase({ client });
    expect(await backend.getWorkflowRun({ workflowRunId: "x" })).toBeNull();
  });

  test("claimWorkflowRun returns null when nothing is claimable", async () => {
    const { client } = mockClient(async () => ({ run: null }));
    const backend = new BackendPocketBase({ client });
    expect(
      await backend.claimWorkflowRun({ workerId: "w", leaseDurationMs: 10 }),
    ).toBeNull();
  });

  test("getStepAttempt returns null on {stepAttempt:null}", async () => {
    const { client } = mockClient(async () => ({ stepAttempt: null }));
    const backend = new BackendPocketBase({ client });
    expect(await backend.getStepAttempt({ stepAttemptId: "x" })).toBeNull();
  });
});

describe("getSignalDelivery", () => {
  test("undefined when not delivered", async () => {
    const { client } = mockClient(async () => ({ delivered: false, data: null }));
    const backend = new BackendPocketBase({ client });
    expect(await backend.getSignalDelivery({ stepAttemptId: "s" })).toBeUndefined();
  });

  test("null when delivered with null data", async () => {
    const { client } = mockClient(async () => ({ delivered: true, data: null }));
    const backend = new BackendPocketBase({ client });
    expect(await backend.getSignalDelivery({ stepAttemptId: "s" })).toBeNull();
  });

  test("value when delivered with data", async () => {
    const { client } = mockClient(async () => ({ delivered: true, data: { ok: true } }));
    const backend = new BackendPocketBase({ client });
    expect(await backend.getSignalDelivery({ stepAttemptId: "s" })).toEqual({ ok: true });
  });
});

describe("sendSignal", () => {
  test("normalizes a null workflowRunIds to []", async () => {
    const { client } = mockClient(async () => ({ workflowRunIds: null }));
    const backend = new BackendPocketBase({ client });
    const res = await backend.sendSignal({ signal: "s", data: null, idempotencyKey: null });
    expect(res.workflowRunIds).toEqual([]);
  });
});

describe("auth", () => {
  test("re-auths once and retries on a 401", async () => {
    let calls = 0;
    const { client, authRefresh } = mockClient(async () => {
      calls += 1;
      if (calls === 1) throw new ClientResponseError({ status: 401 });
      return { counts: { pending: 1, running: 0, completed: 0, failed: 0, canceled: 0 } };
    });
    const backend = new BackendPocketBase({ client });
    const counts = await backend.countWorkflowRuns();
    expect(authRefresh).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(counts.pending).toBe(1);
  });

  test("a non-401 error is propagated without retry", async () => {
    const { client } = mockClient(async () => {
      throw new ClientResponseError({ status: 404 });
    });
    const backend = new BackendPocketBase({ client });
    await expect(backend.getWorkflowRun({ workflowRunId: "x" })).rejects.toBeInstanceOf(
      ClientResponseError,
    );
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});

describe("body serialization", () => {
  test("Date params serialize to millisecond ISO-8601", async () => {
    let captured: any;
    const { client } = mockClient(async (_url, opts) => {
      captured = opts.body;
      return { run: runWire() };
    });
    const backend = new BackendPocketBase({ client });
    const at = new Date("2026-06-02T14:30:45.123Z");
    await backend.sleepWorkflowRun({ workflowRunId: "r", workerId: "w", availableAt: at });

    expect(captured.availableAt).toBeInstanceOf(Date);
    // The SDK JSON.stringifies the body; Date -> toJSON() -> millisecond ISO.
    expect(JSON.parse(JSON.stringify(captured)).availableAt).toBe(
      "2026-06-02T14:30:45.123Z",
    );
  });

  test("send targets the namespaced /api/ow/v1 path", async () => {
    let url = "";
    const { client } = mockClient(async (u) => {
      url = u;
      return { run: runWire() };
    });
    const backend = new BackendPocketBase({ client, namespaceId: "team-a" });
    await backend.getWorkflowRun({ workflowRunId: "run-1" });
    expect(url).toBe("/api/ow/v1/team-a/runs/run-1");
  });
});
