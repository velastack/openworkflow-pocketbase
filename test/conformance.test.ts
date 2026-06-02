import { randomUUID } from "node:crypto";
import { BackendPocketBase } from "../src/index.js";
import { testBackend } from "./backend.testsuite.vendored.js";

// Runs OpenWorkflow's shared backend conformance suite against a live velabase.
// Provide a running server + superuser via env:
//   PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD
// Each test gets an isolated namespace; the credentials constructor variant is
// exercised end-to-end (lazy superuser auth on first call).
const url = process.env.PB_URL ?? "http://127.0.0.1:8090";
const email = process.env.PB_SUPERUSER_EMAIL ?? "";
const password = process.env.PB_SUPERUSER_PASSWORD ?? "";

testBackend({
  setup: async () =>
    new BackendPocketBase({ url, email, password, namespaceId: randomUUID() }),
  teardown: async (backend) => {
    await backend.stop();
  },
});
