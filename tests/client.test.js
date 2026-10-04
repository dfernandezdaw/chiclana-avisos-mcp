import test from "node:test";
import assert from "node:assert/strict";
import { GecorClient } from "../dist/client.js";

test("JWT petitioner extraction accepts only canonical identity fields and aliases", async () => {
  const { extractPetitionerIdentity } = await import("../dist/client.js");
  const token = `header.${Buffer.from(JSON.stringify({ nombre: "Ada", EMAIL: "ada@example.test", movil: "123", ciudadanoId: 9 })).toString("base64url")}.signature`;
  assert.deepEqual(extractPetitionerIdentity(token), { Nombre: "Ada", Email: "ada@example.test", Movil: "123", CiudadanoID: 9 });
});

test("JWT petitioner extraction fails closed for malformed and incomplete claims", async () => {
  const { extractPetitionerIdentity } = await import("../dist/client.js");
  assert.throws(() => extractPetitionerIdentity("not-a-jwt"), /identidad del peticionario requerida/i);
  const token = `header.${Buffer.from(JSON.stringify({ sub: "Ada", id: 9 })).toString("base64url")}.signature`;
  assert.throws(() => extractPetitionerIdentity(token), /identidad del peticionario requerida/i);
});

test("getAyuntamiento posts official detail request and caches the entity", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const entity = { AyuntamientoID: 268, Nombre: "Example", ProcedenciaWeb: 42, UsuarioIDCiudadano: 7, TokenAyuntamiento: "fixture" };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(entity), { status: 200 });
  };
  try {
    const client = new GecorClient({ ayuntamientoID: 268, language: "es", baseUrl: "https://example.invalid" });
    assert.equal((await client.getAyuntamiento()).AyuntamientoID, 268);
    assert.equal((await client.getAyuntamiento()).Nombre, "Example");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.invalid/Utils/getAyuntamientoByAytoID");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { language: "es", ayuntamientoID: 268 });
  } finally { globalThis.fetch = originalFetch; }
});

test("incident creation sources municipality fields from detailed entity", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const entity = { AyuntamientoID: 268, Nombre: "Example", ProcedenciaWeb: 42, UsuarioID: 7, UsuarioIDCiudadano: 999, TokenAyuntamiento: "fixture" };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(url.endsWith("getAyuntamientoByAytoID") ? entity : {}), { status: 200 });
  };
  try {
    const client = new GecorClient({ ayuntamientoID: 268, baseUrl: "https://example.invalid" });
    client.ensureAuthenticated = async () => "fixture-auth";
    await client.nuevaIncidencia({ tipoElementoID: 1, tipoIncID: 2, desAveria: "fixture", x: 1, y: 2 });
    assert.deepEqual(calls.map((call) => call.url.split("/").at(-1)), ["getAyuntamientoByAytoID", "nuevaIncidencia"]);
    const payload = calls[1].body;
    assert.equal(payload.ayuntamientoID, 268);
    assert.equal(payload.tipoProcedenciaID, 42);
    assert.equal(payload.tokenAyto, "fixture");
    assert.equal(payload.usuarioID, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

function withFakeFetch(handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(await handler(url, options)), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("official upload preserves the complete photo data URI", async () => {
  const fake = withFakeFetch(() => ({ rutaFoto: "uploaded.jpg" }));
  try {
    const client = new GecorClient({ baseUrl: "https://example.invalid" });
    client.ensureAuthenticated = async () => "fixture";
    await client.guardarFotoBase64("data:image/png;base64,QUJD==");
    assert.equal(fake.calls[0].body.byteFoto, "data:image/png;base64,QUJD==");
  } finally { fake.restore(); }
});

test("incident request matches official serialized municipality and address fields", async () => {
  const entity = { AyuntamientoID: 268, ProcedenciaWeb: 42, UsuarioID: 71, UsuarioIDCiudadano: 999, TokenAyuntamiento: "municipality-token" };
  const fake = withFakeFetch((url) => url.endsWith("getAyuntamientoByAytoID") ? entity : {});
  try {
    const client = new GecorClient({ ayuntamientoID: 268, baseUrl: "https://example.invalid" });
    client.ensureAuthenticated = async () => "fixture";
    await client.nuevaIncidencia({ tipoElementoID: 6, tipoIncID: 234, desAveria: "Pavimento", x: 36.4, y: -6.1, desUbicacion: "Calle Mayor, 4", numCalle: 4, calleID: 0 });
    assert.equal(fake.calls[1].options.body, JSON.stringify({
      token: "fixture", ayuntamientoID: 268, tipoProcedenciaID: 42, ciudadanoID: 0,
      nombrePeticionario: "Ciudadano", email: "", movil: "", tipoElementoID: 6, desTipoElemento: "",
      tipoIncID: "234", tipoInc: "", desAveria: "Pavimento", x: 36.4, y: -6.1, calleID: 0,
      numCalle: 4, desUbicacion: "Calle Mayor, 4", edificioID: 0, nombreEdificio: "",
      fotos: [], tokenAyto: "municipality-token", estadoAvisoID: -1,
      uni_cod: "", uni_direc: "", pro_cod: "", pro_nomb: ""
    }));
  } finally { fake.restore(); }
});
