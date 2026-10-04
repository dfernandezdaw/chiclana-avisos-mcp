import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { GecorClient, GecorApiError } from "../dist/client.js";
import { createMcpServer } from "../dist/server.js";

const SECRET_TOKEN = "secret-token-1234567890";
const FIXTURE_IMAGE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture image")]);

function withTimeoutEnv(value) {
  const previous = process.env.GECOR_TIMEOUT_MS;
  process.env.GECOR_TIMEOUT_MS = value;
  return () => {
    if (previous === undefined) delete process.env.GECOR_TIMEOUT_MS;
    else process.env.GECOR_TIMEOUT_MS = previous;
  };
}

// Responder may return { status, body } or "hang" (never resolves until the request signal aborts).
function stubFetch(responder) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    const reply = responder(url, calls.length);
    if (reply === "hang") {
      return new Promise((_, reject) => {
        const signal = options?.signal;
        if (!signal) return void setTimeout(() => reject(new Error("request sent without abort signal")), 500);
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return Promise.resolve(new Response(text, { status: reply.status ?? 200 }));
  };
  const endpointCalls = (name) => calls.filter((call) => call.url.endsWith(name)).length;
  return { calls, endpointCalls, restore: () => { globalThis.fetch = originalFetch; } };
}

function testClient() {
  const client = new GecorClient({ ayuntamientoID: 268, baseUrl: "https://example.invalid" });
  client.ensureAuthenticated = async () => SECRET_TOKEN;
  return client;
}

test("hanging GECOR request fails with a timeout error within GECOR_TIMEOUT_MS", async () => {
  const restoreEnv = withTimeoutEnv("50");
  const fake = stubFetch(() => "hang");
  try {
    const started = Date.now();
    await assert.rejects(testClient().guardarFotoBase64("data:image/png;base64,QUJD"), (err) => {
      assert.ok(err instanceof GecorApiError);
      assert.equal(err.kind, "timeout");
      assert.match(err.message, /GECOR no respondió en 0\.05 s/);
      return true;
    });
    assert.ok(Date.now() - started < 2000, "timeout must fire quickly");
    assert.ok(fake.calls[0].options.signal instanceof AbortSignal);
  } finally { fake.restore(); restoreEnv(); }
});

test("invalid GECOR_TIMEOUT_MS falls back to the 20 s default", async () => {
  const { getGecorTimeoutMs } = await import("../dist/config.js");
  for (const value of ["abc", "-5", "0", ""]) {
    const restoreEnv = withTimeoutEnv(value);
    try { assert.equal(getGecorTimeoutMs(), 20000); } finally { restoreEnv(); }
  }
  const restoreEnv = withTimeoutEnv("1500");
  try { assert.equal(getGecorTimeoutMs(), 1500); } finally { restoreEnv(); }
});

test("GECOR error text is truncated, collapsed and never leaks the token or request body", async () => {
  const photo = "data:image/png;base64,UFJJVkFURVBIT1RPREFUQQ==";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";
  const echoed = `Fallo\n\n\tinterno token=${SECRET_TOKEN} jwt=${jwt} foto=${photo} ${"x".repeat(2000)}`;
  const fake = stubFetch(() => ({ status: 500, body: { Message: echoed } }));
  try {
    await assert.rejects(testClient().guardarFotoBase64(photo), (err) => {
      assert.ok(err instanceof GecorApiError);
      assert.equal(err.status, 500);
      assert.equal(err.kind, "http");
      assert.match(err.message, /\(500\) en Incident\/guardarFotoBase64/);
      assert.match(err.message, /Fallo interno/);
      for (const text of [err.message, String(err.body), JSON.stringify(err)]) {
        assert.equal(text.includes(SECRET_TOKEN), false, "token leaked");
        assert.equal(text.includes(jwt), false, "jwt leaked");
        assert.equal(text.includes(photo), false, "request body leaked");
        assert.equal(text.includes(fake.calls[0].options.body), false, "request body leaked");
      }
      assert.doesNotMatch(err.message, /[\n\t]/);
      const snippet = err.message.split("Incident/guardarFotoBase64: ")[1] ?? "";
      assert.ok(snippet.length > 0 && snippet.length <= 300, `snippet length ${snippet.length}`);
      return true;
    });
  } finally { fake.restore(); }
});

test("write endpoints are never retried on 5xx or timeout", async () => {
  const entity = { AyuntamientoID: 268, ProcedenciaWeb: 42, TokenAyuntamiento: "fixture" };
  let fake = stubFetch((url) => url.endsWith("getAyuntamientoByAytoID") ? { body: entity } : { status: 503, body: "busy" });
  try {
    await assert.rejects(testClient().nuevaIncidencia({ ciudadanoID: 9, nombrePeticionario: "Ada", email: "ada@example.test", movil: "600111222", tipoElementoID: 1, tipoIncID: 2, desAveria: "d", x: 1, y: 2 }), GecorApiError);
    assert.equal(fake.endpointCalls("nuevaIncidencia"), 1);
    await assert.rejects(testClient().guardarFotoBase64("data:image/png;base64,QUJD"), GecorApiError);
    assert.equal(fake.endpointCalls("guardarFotoBase64"), 1);
  } finally { fake.restore(); }

  const restoreEnv = withTimeoutEnv("30");
  fake = stubFetch((url) => url.endsWith("getAyuntamientoByAytoID") ? { body: entity } : "hang");
  try {
    await assert.rejects(testClient().nuevaIncidencia({ ciudadanoID: 9, nombrePeticionario: "Ada", email: "ada@example.test", movil: "600111222", tipoElementoID: 1, tipoIncID: 2, desAveria: "d", x: 1, y: 2 }), { kind: "timeout" });
    assert.equal(fake.endpointCalls("nuevaIncidencia"), 1);
  } finally { fake.restore(); restoreEnv(); }
});

test("read endpoints retry at most once on timeout or 5xx, never on 4xx", async () => {
  const restoreEnv = withTimeoutEnv("30");
  let fake = stubFetch(() => "hang");
  try {
    await assert.rejects(testClient().getMisIncidencias(), { kind: "timeout" });
    assert.equal(fake.calls.length, 2);
  } finally { fake.restore(); restoreEnv(); }

  fake = stubFetch((_, n) => n === 1 ? { status: 502, body: "bad gateway" } : { body: [{ AvisoID: 1 }] });
  try {
    assert.deepEqual(await testClient().getMisIncidencias(), [{ AvisoID: 1 }]);
    assert.equal(fake.calls.length, 2);
  } finally { fake.restore(); }

  fake = stubFetch(() => ({ status: 401, body: "unauthorized" }));
  try {
    await assert.rejects(testClient().getMisIncidencias(), { status: 401 });
    assert.equal(fake.calls.length, 1);
  } finally { fake.restore(); }
});

class TestTransport {
  onmessage;
  onerror;
  onclose;
  peer;
  async start() {}
  async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }
  async close() { this.onclose?.(); }
}

async function submitWith(fakeOverrides) {
  const previous = process.env.GECOR_ALLOW_SUBMISSION;
  process.env.GECOR_ALLOW_SUBMISSION = "true";
  const calls = { upload: 0, submit: 0 };
  const fakeClient = {
    ayuntamientoID: 268,
    getPetitionerIdentity() { return { Nombre: "Ada", Email: "ada@example.test", Movil: "123", CiudadanoID: 9 }; },
    async getAyuntamiento() { return { AyuntamientoID: 268, Nombre: "Example" }; },
    async guardarFotoBase64() { calls.upload++; return fakeOverrides.upload(); },
    async nuevaIncidencia() { calls.submit++; return fakeOverrides.submit(); },
  };
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const left = new TestTransport();
  const right = new TestTransport();
  left.peer = right;
  right.peer = left;
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const previewResult = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      description: "fixture", tipoElementoID: 1, tipoIncID: 2, lat: 36, lng: -6,
      image_base64: FIXTURE_IMAGE.toString("base64"),
    } });
    const { preview_token } = JSON.parse(previewResult.content[0].text);
    const args = { preview_token, confirm: true, human_confirmed: true };
    const result = await client.callTool({ name: "create_aviso_from_photo", arguments: args });
    const replay = await client.callTool({ name: "create_aviso_from_photo", arguments: args });
    return { result, replay, calls };
  } finally {
    await client.close();
    await server.close();
    if (previous === undefined) delete process.env.GECOR_ALLOW_SUBMISSION;
    else process.env.GECOR_ALLOW_SUBMISSION = previous;
  }
}

test("photo uploaded but incident creation fails reports an unconfirmed partial outcome", async () => {
  const { result, replay, calls } = await submitWith({
    upload: async () => "fixture-photo",
    submit: async () => { throw new GecorApiError(500, "Incident/nuevaIncidencia", "boom"); },
  });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /foto se subió/i);
  assert.match(text, /NO.*confirm/);
  assert.match(text, /list_my_avisos/);
  assert.match(text, /no reintentes/i);
  assert.match(text, /nueva previsualización/i);
  assert.equal(replay.isError, true, "preview token stays single-use");
  assert.deepEqual(calls, { upload: 1, submit: 1 });
});

test("incident creation timeout is reported as an ambiguous outcome", async () => {
  const { result } = await submitWith({
    upload: async () => "fixture-photo",
    submit: async () => { throw new GecorApiError(0, "Incident/nuevaIncidencia", undefined, { kind: "timeout", timeoutMs: 20000 }); },
  });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /GECOR no respondió en 20 s/);
  assert.match(text, /ambiguo/i);
  assert.match(text, /list_my_avisos/);
  assert.match(text, /no reintentes/i);
});

test("photo upload failure reports that nothing was created", async () => {
  const { result, replay, calls } = await submitWith({
    upload: async () => { throw new GecorApiError(500, "Incident/guardarFotoBase64", "boom"); },
    submit: async () => ({ accepted: true }),
  });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /no se ha creado ningún aviso/i);
  assert.match(text, /nueva previsualización/i);
  assert.equal(replay.isError, true);
  assert.deepEqual(calls, { upload: 1, submit: 0 });
});

test("GECOR_TIMEOUT_MS above the 120 s maximum is clamped to the maximum", async () => {
  const { getGecorTimeoutMs } = await import("../dist/config.js");
  for (const [value, expected] of [["120000", 120000], ["120001", 120000], ["99999999", 120000], ["119999", 119999]]) {
    const restoreEnv = withTimeoutEnv(value);
    try { assert.equal(getGecorTimeoutMs(), expected, `GECOR_TIMEOUT_MS=${value}`); } finally { restoreEnv(); }
  }
});

test("GECOR error text redacts JSON-escaped forms of sensitive request values", async () => {
  const entity = { AyuntamientoID: 268, ProcedenciaWeb: 42, TokenAyuntamiento: "fixture" };
  const desAveria = 'Farola "rota" en C\\ Ancha/Mayor junto al kiosco de José Ángel';
  const asciiEscaped = (s) => s.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const jsonInner = JSON.stringify(desAveria).slice(1, -1);
  const forms = [
    jsonInner,
    jsonInner.replace(/\//g, "\\/"),
    asciiEscaped(jsonInner),
    asciiEscaped(jsonInner).replace(/\//g, "\\/"),
    asciiEscaped(jsonInner).replace(/\\u([0-9a-f]{4})/g, (_, h) => `\\u${h.toUpperCase()}`),
  ];
  for (const form of forms) {
    const fake = stubFetch((url) => url.endsWith("getAyuntamientoByAytoID")
      ? { body: entity }
      : { status: 400, body: `{"Message":"Invalid desAveria: ${form}"}` });
    try {
      await assert.rejects(testClient().nuevaIncidencia({ ciudadanoID: 9, nombrePeticionario: "Ada", email: "ada@example.test", movil: "600111222", tipoElementoID: 1, tipoIncID: 2, desAveria, x: 1, y: 2 }), (err) => {
        assert.ok(err instanceof GecorApiError);
        assert.match(err.message, /Invalid desAveria: \[redactado\]/, `form leaked: ${form}`);
        for (const text of [err.message, String(err.body)]) {
          assert.equal(text.includes("kiosco"), false, `form leaked: ${form}`);
        }
        return true;
      });
    } finally { fake.restore(); }
  }
});

test("incident creation network failure is reported as an ambiguous outcome", async () => {
  const { result } = await submitWith({
    upload: async () => "fixture-photo",
    submit: async () => { throw new GecorApiError(0, "Incident/nuevaIncidencia", undefined, { kind: "network" }); },
  });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /No se pudo conectar con GECOR/);
  assert.match(text, /ambiguo/i);
  assert.match(text, /podría haberse creado/i);
  assert.match(text, /list_my_avisos/);
});

test("incident creation HTTP error with a definite status is not reported as ambiguous", async () => {
  const { result } = await submitWith({
    upload: async () => "fixture-photo",
    submit: async () => { throw new GecorApiError(400, "Incident/nuevaIncidencia", "bad request"); },
  });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.doesNotMatch(text, /ambiguo/i);
  assert.match(text, /list_my_avisos/);
});

test("incident creation gateway 5xx is reported as an ambiguous outcome", async () => {
  for (const status of [502, 504]) {
    const { result } = await submitWith({
      upload: async () => "fixture-photo",
      submit: async () => { throw new GecorApiError(status, "Incident/nuevaIncidencia", "Bad Gateway"); },
    });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /ambiguo/i, `status ${status}`);
    assert.match(text, /podría haberse creado/i);
    assert.match(text, /list_my_avisos/);
  }
});
