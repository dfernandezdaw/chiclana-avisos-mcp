import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../dist/server.js";

class TestTransport {
  onmessage;
  onerror;
  onclose;
  peer;
  async start() {}
  async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }
  async close() { this.onclose?.(); }
}

function linkedTransports() {
  const left = new TestTransport();
  const right = new TestTransport();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

const PETITIONER = { Nombre: "Peticionaria Secreta", Email: "secreta@example.test", Movil: "600999888", CiudadanoID: 4242 };
const PETITIONER_MARKERS = [PETITIONER.Nombre, PETITIONER.Email, PETITIONER.Movil, "4242", "peticionario", "petitioner", "CiudadanoID"];

function responseText(result) {
  return result.content.map((item) => item.text ?? "").join("\n");
}

// Preview tokens are random UUIDs and may contain digit markers such as "4242"; mask them so marker checks are deterministic.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function assertNoPetitioner(result, label) {
  const text = responseText(result).replace(UUID_PATTERN, "<uuid>");
  for (const marker of PETITIONER_MARKERS) {
    assert.equal(text.includes(marker), false, `${label} must not expose ${marker}`);
  }
}

async function withServer(run) {
  const previousAllow = process.env.GECOR_ALLOW_SUBMISSION;
  const previousFetch = globalThis.fetch;
  process.env.GECOR_ALLOW_SUBMISSION = "true";
  const calls = { fetch: [], client: [] };
  globalThis.fetch = async (...fetchArgs) => {
    calls.fetch.push(String(fetchArgs[0]));
    throw new Error("network disabled in tests");
  };
  const fakeClient = {
    ayuntamientoID: 268,
    getPetitionerIdentity() { calls.client.push("getPetitionerIdentity"); return { ...PETITIONER }; },
    async getAyuntamiento() { calls.client.push("getAyuntamiento"); return { AyuntamientoID: 268, Nombre: "Example" }; },
    async guardarFotoBase64() { calls.client.push("guardarFotoBase64"); return "fixture-photo"; },
    async nuevaIncidencia() { calls.client.push("nuevaIncidencia"); return { accepted: true }; },
  };
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const [clientTransport, serverTransport] = linkedTransports();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await run(client, calls);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = previousFetch;
    if (previousAllow === undefined) delete process.env.GECOR_ALLOW_SUBMISSION;
    else process.env.GECOR_ALLOW_SUBMISSION = previousAllow;
  }
}

const FIXTURE_IMAGE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture image")]);
const previewArgs = {
  description: "farola rota", tipoElementoID: 1, tipoIncID: 2,
  lat: 36, lng: -6, image_base64: FIXTURE_IMAGE.toString("base64"),
};

test("unlisted tool names are rejected without performing any action", async () => {
  await withServer(async (client, calls) => {
    const listed = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const name of ["preview", "submit", "create_aviso_preview", "create_aviso", "constructor", "__proto__", "toString"]) {
      assert.equal(listed.has(name), false, `${name} must not be listed`);
      const result = await client.callTool({ name, arguments: { ...previewArgs, confirm: true, human_confirmed: true, preview_token: "x" } });
      assert.equal(result.isError, true, `${name} must be rejected`);
      assert.match(responseText(result), new RegExp(`Herramienta desconocida: ${name}`));
      assertNoPetitioner(result, name);
    }
    assert.deepEqual(calls, { fetch: [], client: [] });
  });
});

test("raw submit cannot consume a facade preview token", async () => {
  await withServer(async (client, calls) => {
    const previewResult = await client.callTool({ name: "create_aviso_from_photo", arguments: previewArgs });
    assert.equal(previewResult.isError, undefined);
    assertNoPetitioner(previewResult, "facade preview");
    const { preview_token } = JSON.parse(responseText(previewResult));
    calls.client.length = 0;

    const raw = await client.callTool({ name: "submit", arguments: { preview_token, confirm: true, human_confirmed: true } });
    assert.equal(raw.isError, true);
    assert.deepEqual(calls, { fetch: [], client: [] });

    const accepted = await client.callTool({ name: "create_aviso_from_photo", arguments: { preview_token, confirm: true, human_confirmed: true } });
    assert.equal(accepted.isError, undefined, "token must remain valid after a rejected raw submit");
    assertNoPetitioner(accepted, "facade submit");
    assert.deepEqual(calls.client, ["guardarFotoBase64", "nuevaIncidencia"]);
    assert.deepEqual(calls.fetch, []);
  });
});
