import PocketBase, { ClientResponseError } from "pocketbase";
import type {
  Backend,
  CancelWorkflowRunParams,
  ClaimWorkflowRunParams,
  CompleteStepAttemptParams,
  CompleteWorkflowRunParams,
  CreateStepAttemptParams,
  CreateWorkflowRunParams,
  ExtendWorkflowRunLeaseParams,
  FailStepAttemptParams,
  FailWorkflowRunParams,
  GetSignalDeliveryParams,
  GetStepAttemptParams,
  GetWorkflowRunParams,
  ListStepAttemptsParams,
  ListWorkflowRunsParams,
  PaginatedResponse,
  RescheduleWorkflowRunAfterFailedStepAttemptParams,
  SendSignalParams,
  SendSignalResult,
  SetStepAttemptChildWorkflowRunParams,
  SleepWorkflowRunParams,
  StepAttempt,
  WorkflowRun,
  WorkflowRunCounts,
} from "openworkflow/internal";
import { reviveRun, reviveStep, revivePaginated } from "./revive.js";

/** Matches the server's `DEFAULT_NAMESPACE_ID`. */
const DEFAULT_NAMESPACE_ID = "default";
const SUPERUSERS = "_superusers";

export type BackendPocketBaseOptions =
  // Pre-authed client owned by the caller (advanced; e.g. one shared client).
  | { client: PocketBase; namespaceId?: string }
  // Credentials: the binding authenticates lazily as a superuser.
  | { url: string; email: string; password: string; namespaceId?: string };

/**
 * An OpenWorkflow {@link Backend} that talks to a velabase
 * `/api/ow/v1/{namespace}` HTTP API. Each method is one authenticated
 * `pb.send()` against the matching endpoint; a superuser-authed
 * `pocketbase-sveltekit` client is effectively "the DB connection".
 */
export class BackendPocketBase implements Backend {
  private readonly pb: PocketBase;
  private readonly ns: string;
  private readonly creds?: { email: string; password: string };
  private authPromise: Promise<unknown> | null = null;

  constructor(options: BackendPocketBaseOptions) {
    this.ns = options.namespaceId ?? DEFAULT_NAMESPACE_ID;
    if ("client" in options) {
      this.pb = options.client;
    } else {
      this.pb = new PocketBase(options.url);
      this.creds = { email: options.email, password: options.password };
    }
    // Workers poll the same endpoints repeatedly; the SDK's default
    // auto-cancellation would abort concurrent requests sharing a key.
    this.pb.autoCancellation(false);
  }

  // --- auth ---

  /** Authenticate once (lazily) when constructed with credentials. */
  private ensureAuth(): Promise<unknown> {
    if (this.creds && !this.pb.authStore.isValid) {
      this.authPromise ??= this.pb
        .collection(SUPERUSERS)
        .authWithPassword(this.creds.email, this.creds.password);
    }
    return this.authPromise ?? Promise.resolve(undefined);
  }

  /** Re-authenticate after a 401 (superuser tokens expire). */
  private async reauth(): Promise<void> {
    this.authPromise = null;
    if (this.creds) {
      this.authPromise = this.pb
        .collection(SUPERUSERS)
        .authWithPassword(this.creds.email, this.creds.password);
      await this.authPromise;
    } else if (this.pb.authStore.isValid) {
      // Caller owns auth; try an opportunistic refresh.
      await this.pb.collection(SUPERUSERS).authRefresh();
    }
  }

  private async send<T>(
    path: string,
    method: string,
    body?: unknown,
    query?: Record<string, unknown>,
  ): Promise<T> {
    await this.ensureAuth();
    const url = `/api/ow/v1/${this.ns}${path}`;
    const options = { method, body, query, requestKey: null };
    try {
      return await this.pb.send<T>(url, options);
    } catch (e) {
      if (e instanceof ClientResponseError && e.status === 401) {
        await this.reauth();
        return await this.pb.send<T>(url, options);
      }
      // ClientResponseError is an Error with .status and .response; preserve it.
      throw e;
    }
  }

  // --- workflow runs ---

  async createWorkflowRun(
    params: Readonly<CreateWorkflowRunParams>,
  ): Promise<WorkflowRun> {
    const res = await this.send<{ run: any }>("/runs", "POST", {
      workflowName: params.workflowName,
      version: params.version,
      idempotencyKey: params.idempotencyKey,
      config: params.config,
      context: params.context,
      input: params.input,
      parentStepAttemptNamespaceId: params.parentStepAttemptNamespaceId,
      parentStepAttemptId: params.parentStepAttemptId,
      availableAt: params.availableAt,
      deadlineAt: params.deadlineAt,
    });
    return reviveRun(res.run);
  }

  async getWorkflowRun(
    params: Readonly<GetWorkflowRunParams>,
  ): Promise<WorkflowRun | null> {
    const res = await this.send<{ run: any | null }>(
      `/runs/${params.workflowRunId}`,
      "GET",
    );
    return res.run ? reviveRun(res.run) : null;
  }

  async listWorkflowRuns(
    params: Readonly<ListWorkflowRunsParams>,
  ): Promise<PaginatedResponse<WorkflowRun>> {
    const res = await this.send<{ data?: unknown[]; pagination?: any }>(
      "/runs",
      "GET",
      undefined,
      listQuery(params),
    );
    return revivePaginated(res, reviveRun);
  }

  async countWorkflowRuns(): Promise<WorkflowRunCounts> {
    const res = await this.send<{ counts: WorkflowRunCounts }>(
      "/runs/counts",
      "GET",
    );
    return res.counts;
  }

  async claimWorkflowRun(
    params: Readonly<ClaimWorkflowRunParams>,
  ): Promise<WorkflowRun | null> {
    const res = await this.send<{ run: any | null }>("/claim", "POST", {
      workerId: params.workerId,
      leaseDurationMs: params.leaseDurationMs,
    });
    return res.run ? reviveRun(res.run) : null;
  }

  async extendWorkflowRunLease(
    params: Readonly<ExtendWorkflowRunLeaseParams>,
  ): Promise<WorkflowRun> {
    const res = await this.send<{ run: any }>(
      `/runs/${params.workflowRunId}/lease`,
      "POST",
      { workerId: params.workerId, leaseDurationMs: params.leaseDurationMs },
    );
    return reviveRun(res.run);
  }

  async sleepWorkflowRun(
    params: Readonly<SleepWorkflowRunParams>,
  ): Promise<WorkflowRun> {
    const res = await this.send<{ run: any }>(
      `/runs/${params.workflowRunId}/sleep`,
      "POST",
      { workerId: params.workerId, availableAt: params.availableAt },
    );
    return reviveRun(res.run);
  }

  async completeWorkflowRun(
    params: Readonly<CompleteWorkflowRunParams>,
  ): Promise<WorkflowRun> {
    const res = await this.send<{ run: any }>(
      `/runs/${params.workflowRunId}/complete`,
      "POST",
      { workerId: params.workerId, output: params.output },
    );
    return reviveRun(res.run);
  }

  async failWorkflowRun(
    params: Readonly<FailWorkflowRunParams>,
  ): Promise<WorkflowRun> {
    const res = await this.send<{ run: any }>(
      `/runs/${params.workflowRunId}/fail`,
      "POST",
      {
        workerId: params.workerId,
        error: params.error,
        retryPolicy: params.retryPolicy,
        attempts: params.attempts,
        deadlineAt: params.deadlineAt,
      },
    );
    return reviveRun(res.run);
  }

  async rescheduleWorkflowRunAfterFailedStepAttempt(
    params: Readonly<RescheduleWorkflowRunAfterFailedStepAttemptParams>,
  ): Promise<WorkflowRun> {
    const res = await this.send<{ run: any }>(
      `/runs/${params.workflowRunId}/reschedule`,
      "POST",
      {
        workerId: params.workerId,
        error: params.error,
        availableAt: params.availableAt,
      },
    );
    return reviveRun(res.run);
  }

  async cancelWorkflowRun(
    params: Readonly<CancelWorkflowRunParams>,
  ): Promise<WorkflowRun> {
    const res = await this.send<{ run: any }>(
      `/runs/${params.workflowRunId}/cancel`,
      "POST",
      {},
    );
    return reviveRun(res.run);
  }

  // --- step attempts ---

  async createStepAttempt(
    params: Readonly<CreateStepAttemptParams>,
  ): Promise<StepAttempt> {
    const res = await this.send<{ stepAttempt: any }>(
      `/runs/${params.workflowRunId}/steps`,
      "POST",
      {
        workerId: params.workerId,
        stepName: params.stepName,
        kind: params.kind,
        config: params.config,
        context: params.context,
      },
    );
    return reviveStep(res.stepAttempt);
  }

  async getStepAttempt(
    params: Readonly<GetStepAttemptParams>,
  ): Promise<StepAttempt | null> {
    const res = await this.send<{ stepAttempt: any | null }>(
      `/steps/${params.stepAttemptId}`,
      "GET",
    );
    return res.stepAttempt ? reviveStep(res.stepAttempt) : null;
  }

  async listStepAttempts(
    params: Readonly<ListStepAttemptsParams>,
  ): Promise<PaginatedResponse<StepAttempt>> {
    const res = await this.send<{ data?: unknown[]; pagination?: any }>(
      `/runs/${params.workflowRunId}/steps`,
      "GET",
      undefined,
      listQuery(params),
    );
    return revivePaginated(res, reviveStep);
  }

  async completeStepAttempt(
    params: Readonly<CompleteStepAttemptParams>,
  ): Promise<StepAttempt> {
    const res = await this.send<{ stepAttempt: any }>(
      `/runs/${params.workflowRunId}/steps/${params.stepAttemptId}/complete`,
      "POST",
      { workerId: params.workerId, output: params.output },
    );
    return reviveStep(res.stepAttempt);
  }

  async failStepAttempt(
    params: Readonly<FailStepAttemptParams>,
  ): Promise<StepAttempt> {
    const res = await this.send<{ stepAttempt: any }>(
      `/runs/${params.workflowRunId}/steps/${params.stepAttemptId}/fail`,
      "POST",
      { workerId: params.workerId, error: params.error },
    );
    return reviveStep(res.stepAttempt);
  }

  async setStepAttemptChildWorkflowRun(
    params: Readonly<SetStepAttemptChildWorkflowRunParams>,
  ): Promise<StepAttempt> {
    const res = await this.send<{ stepAttempt: any }>(
      `/runs/${params.workflowRunId}/steps/${params.stepAttemptId}/child`,
      "POST",
      {
        workerId: params.workerId,
        childWorkflowRunNamespaceId: params.childWorkflowRunNamespaceId,
        childWorkflowRunId: params.childWorkflowRunId,
      },
    );
    return reviveStep(res.stepAttempt);
  }

  // --- signals ---

  async sendSignal(
    params: Readonly<SendSignalParams>,
  ): Promise<SendSignalResult> {
    const res = await this.send<{ workflowRunIds: string[] | null }>(
      "/signals",
      "POST",
      {
        signal: params.signal,
        data: params.data,
        idempotencyKey: params.idempotencyKey,
      },
    );
    return { workflowRunIds: res.workflowRunIds ?? [] };
  }

  async getSignalDelivery(
    params: Readonly<GetSignalDeliveryParams>,
  ): ReturnType<Backend["getSignalDelivery"]> {
    const res = await this.send<{ delivered: boolean; data: any }>(
      `/steps/${params.stepAttemptId}/signal`,
      "GET",
    );
    return res.delivered ? res.data : undefined;
  }

  // --- lifecycle ---

  async stop(): Promise<void> {
    this.authPromise = null;
    return Promise.resolve();
  }
}

/** Build the cursor-pagination query (limit/after/before), omitting absent keys. */
function listQuery(params: {
  limit?: number;
  after?: string;
  before?: string;
}): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (params.limit != null) q.limit = params.limit;
  if (params.after != null) q.after = params.after;
  if (params.before != null) q.before = params.before;
  return q;
}
