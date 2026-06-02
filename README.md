# openworkflow-pocketbase

An [OpenWorkflow](https://openworkflow.dev) `Backend` implementation that talks to a
[PocketBase](https://github.com/velastack/velabase) `/api/ow/v1/{namespace}` HTTP API. With
it, an **unmodified** OpenWorkflow `Worker` + replay engine runs against a central velabase
(PocketBase) instead of an in-process SQLite/Postgres backend.

It is a thin wrapper: a superuser-authed [`pocketbase`](https://github.com/pocketbase/js-sdk)
client is effectively "the DB connection", and each `Backend` method is one `pb.send()`
against the matching endpoint. It uses only the standard PocketBase JS SDK API, so it works
with the official `pocketbase` package (or any drop-in fork of it).

## Install

```sh
npm install openworkflow-pocketbase openworkflow pocketbase
```

`openworkflow` and `pocketbase` are peer dependencies (ESM-only, Node ≥ 20).

## Usage

```ts
import { OpenWorkflow } from "openworkflow";
import { BackendPocketBase } from "openworkflow-pocketbase";

const backend = new BackendPocketBase({
  url: "http://localhost:8090",
  email: process.env.PB_SUPERUSER_EMAIL!,
  password: process.env.PB_SUPERUSER_PASSWORD!,
  namespaceId: "default", // optional; defaults to "default"
});

const ow = new OpenWorkflow({ backend });
// defineWorkflow / run / newWorker exactly as with BackendSqlite / BackendPostgres —
// the Worker + replay engine are unchanged.
```

Advanced — pass a pre-authed client you own (e.g. one shared across namespaces):

```ts
import PocketBase from "pocketbase";

const pb = new PocketBase("http://localhost:8090");
await pb.collection("_superusers").authWithPassword(email, password);

const backend = new BackendPocketBase({ client: pb, namespaceId: "team-a" });
```

The binding sets `autoCancellation(false)` (workers poll repeatedly), authenticates lazily,
and re-authenticates once on a `401`.

## Compatibility

- Targets PocketBase's OpenWorkflow plugin **schema v5**.

## Development & tests

```sh
npm install
npm run build        # tsc -> dist/ (ESM + .d.ts)
npm run test:unit    # unit tests only (no server needed)
```

**Conformance** runs OpenWorkflow's shared backend suite against a live PocketBase instnace. Start a
server and point the tests at it:

```sh
# from a PocketBase checkout (with the openworkflow plugin):
go build -o /tmp/pocketbase ./examples/base
/tmp/pocketbase superuser upsert test@example.com openworkflow-test-pw --dir /tmp/pb_data
/tmp/pocketbase serve --dir /tmp/pb_data --http 127.0.0.1:8090 &

PB_URL=http://127.0.0.1:8090 \
PB_SUPERUSER_EMAIL=test@example.com \
PB_SUPERUSER_PASSWORD=openworkflow-test-pw \
  npm test
```

CI does the same against a published release binary (`.github/workflows/conformance.yml`).

### Vendored conformance suite

`test/backend.testsuite.vendored.ts` is a copy of OpenWorkflow's
`packages/openworkflow/testing/backend.testsuite.ts`. **Re-sync it on each `openworkflow`
release.** Only three edits vs upstream:

1. imports rewritten to the public `openworkflow/internal` surface;
2. `DEFAULT_WORKFLOW_RETRY_POLICY` inlined (it is not publicly exported);
3. one clock-mocked test (`…older than the idempotency period`) is `.skip`ped — its
   `vi.spyOn(Date,"now")` cannot affect the remote server's clock.
