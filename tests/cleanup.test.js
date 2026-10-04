import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../dist/server.js";
import { GecorClient } from "../dist/client.js";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PETITIONER = { ciudadanoID: 9, nombrePeticionario: "Ada", email: "ada@example.test", movil: "600111222" };
const INCIDENT = { tipoElementoID: 1, tipoIncID: 2, desAveria: "fixture", x: 1, y: 2 };

class TestTransport {
  onmessage;
  onerror;
  onclose;
  peer;
  async start() {}
  async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }
  async close() { this.onclose?.(); }
}

async function withServer(fakeClient, run) {
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const left = new TestTransport();
  const right = new TestTransport();
  left.peer = right;
  right.peer = left;
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function withFakeFetch(entity) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(url.endsWith("getAyuntamientoByAytoID") ? entity : {}), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function newClient() {
  const client = new GecorClient({ ayuntamientoID: 268, baseUrl: "https://example.invalid" });
  client.ensureAuthenticated = async () => "fixture";
  return client;
}

test("whoami reports municipality and auth state without a usuario field", async () => {
  const fakeClient = {
    ayuntamientoID: 268,
    hasToken: () => true,
    async getAyuntamiento() { return { AyuntamientoID: 268, Nombre: "Example", Latitud: 36, Longitud: -6 }; },
  };
  await withServer(fakeClient, async (client) => {
    const result = await client.callTool({ name: "whoami", arguments: {} });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.autenticado, true);
    assert.equal(body.municipio_activo.AyuntamientoID, 268);
    assert.equal(Object.hasOwn(body, "usuario"), false);
  });
});

test("MCP initialize reports the package.json version", async () => {
  await withServer({ ayuntamientoID: 268 }, async (client) => {
    assert.equal(client.getServerVersion()?.version, PACKAGE_VERSION);
  });
  // package.json may match the stale literal, so also guard against a hardcoded version literal in the build.
  const serverSource = readFileSync(new URL("../dist/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(serverSource, /version:\s*"\d+\.\d+\.\d+"/);
});

for (const field of Object.keys(PETITIONER)) {
  test(`incident creation fails closed when petitioner ${field} is missing`, async () => {
    const fake = withFakeFetch({ AyuntamientoID: 268, ProcedenciaWeb: 42 });
    try {
      const input = { ...INCIDENT, ...PETITIONER };
      delete input[field];
      await assert.rejects(newClient().nuevaIncidencia(input), /peticionario/i);
      assert.equal(fake.calls.some((call) => call.url.endsWith("nuevaIncidencia")), false);
    } finally { fake.restore(); }
  });
}

test("incident creation rejects a blank petitioner name instead of defaulting", async () => {
  const fake = withFakeFetch({ AyuntamientoID: 268, ProcedenciaWeb: 42 });
  try {
    await assert.rejects(newClient().nuevaIncidencia({ ...INCIDENT, ...PETITIONER, nombrePeticionario: "  " }), /peticionario/i);
    assert.equal(fake.calls.some((call) => call.url.endsWith("nuevaIncidencia")), false);
  } finally { fake.restore(); }
});

async function procedenciaFor(envValue, entity = { AyuntamientoID: 268 }) {
  const previous = process.env.GECOR_PROCEDENCIA_WEB;
  if (envValue === undefined) delete process.env.GECOR_PROCEDENCIA_WEB;
  else process.env.GECOR_PROCEDENCIA_WEB = envValue;
  const fake = withFakeFetch(entity);
  try {
    await newClient().nuevaIncidencia({ ...INCIDENT, ...PETITIONER });
    return fake.calls.find((call) => call.url.endsWith("nuevaIncidencia")).body.tipoProcedenciaID;
  } finally {
    fake.restore();
    if (previous === undefined) delete process.env.GECOR_PROCEDENCIA_WEB;
    else process.env.GECOR_PROCEDENCIA_WEB = previous;
  }
}

test("GECOR_PROCEDENCIA_WEB is the fallback when the municipality lacks ProcedenciaWeb", async () => {
  assert.equal(await procedenciaFor("777"), 777);
});

test("invalid GECOR_PROCEDENCIA_WEB values fall back to 1390", async () => {
  assert.equal(await procedenciaFor(undefined), 1390);
  for (const value of ["0", "-5", "1.5", "abc"]) assert.equal(await procedenciaFor(value), 1390, value);
});

test("municipality ProcedenciaWeb takes precedence over GECOR_PROCEDENCIA_WEB", async () => {
  assert.equal(await procedenciaFor("777", { AyuntamientoID: 268, ProcedenciaWeb: 42 }), 42);
});
