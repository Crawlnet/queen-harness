import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanText } from "../src/sanitize.ts";
import { str } from "../src/free/common.ts";
import { configuredTerms, createRedactor, redactionTerms } from "../src/redact.ts";
import { createToolsWith } from "../src/registry.ts";
import { makeCtx } from "./helpers.ts";

describe("redaction guard", () => {
  it("has no terms by default: text passes unchanged", () => {
    const r = createRedactor(redactionTerms({}));
    assert.deepEqual(r.terms, []);
    const t = "Acmedata says hi https://acmedata.example/x";
    assert.equal(r.text(t), t);
    assert.equal(r.blocked(t), false);
  });

  it("takes terms from TOOLS_REDACT_TERMS (comma list, case-insensitive, short ones ignored)", () => {
    const terms = redactionTerms({ TOOLS_REDACT_TERMS: " Acmedata , DataCo Pro,ab ,  " });
    assert.deepEqual(terms, ["dataco pro", "acmedata"]);
  });

  it("removes whole words and links holding a term, any case, any spelling around it", () => {
    const r = createRedactor(["acmedata"]);
    assert.equal(r.text("Data from Acmedata and AskAcmedata, also acmedatas."), "Data from and, also.");
    assert.equal(r.text("see https://docs.acmedata.example/a?b=1 and www.acmedata.example/x now"), "see and now");
    assert.equal(r.text("nothing to see"), "nothing to see");
    assert.equal(r.blocked("ACMEDATA"), true);
  });

  it("TOOLS_REDACT_KEEP: ordinary words that hold a term stay", () => {
    const r = createRedactor(["acme"], ["acmeic"]);
    assert.equal(r.text("Acme data on acmeic chains"), "data on acmeic chains");
    assert.equal(r.blocked("Acmeic chains explained"), false);
    assert.equal(r.blocked("Acmeic chains by Acme"), true);
    assert.deepEqual(r.sources([{ title: "Acmeic vs modular", url: "https://news.example.org/acmeic-vs-modular" }]).length, 1);
  });

  it("deep: redacts every string, nulls a blocked url field, drops a record linking to a blocked host", () => {
    const r = createRedactor(["acmedata.example", "acmedata"]);
    const out = r.deep({
      a: "via acmedata",
      list: [
        { title: "ok", url: "https://news.example.org/a" },
        { title: "theirs", url: "https://blog.acmedata.example/b" },
      ],
      nested: { link: "https://acmedata.example/x", keep: 1 },
    });
    assert.deepEqual(out, { a: "via", list: [{ title: "ok", url: "https://news.example.org/a" }], nested: { link: null, keep: 1 } });
  });

  it("sources: drops a source whose title or URL holds a term", () => {
    const r = createRedactor(["acmedata"]);
    assert.deepEqual(
      r.sources([
        { title: "Solscan: tx", url: "https://solscan.io/tx/abc" },
        { title: "Acmedata dashboard", url: "https://solscan.io/tx/def" },
        { title: "x", url: "https://acmedata.example/run/1" },
      ]),
      [{ title: "Solscan: tx", url: "https://solscan.io/tx/abc" }],
    );
  });

  it("the module exposes the same guard for the chat brain's final answers", () => {
    const ctx = makeCtx({ TOOLS_REDACT_TERMS: "acmedata,other-data.example" });
    const tools = createToolsWith(ctx, { background: false, fetch: async () => new Response("{}") });
    assert.equal(tools.redact("per Acmedata and other-data.example: TVL is $1"), "per and: TVL is $1");
    assert.deepEqual(tools.redactSources([{ title: "t", url: "https://api.other-data.example/x" }]), []);
    tools.stop();
  });

  it("spelled variants of a one-word term go too: separators, full-width, zero-width, accents, look-alike letters", () => {
    const r = createRedactor(["acmedata"]);
    for (const v of ["Acme-data", "ACME DATA", "acme.data", "acme_data", "Acme - Data", "ＡＣＭＥＤＡＴＡ", "Acme\u200bdata", "Ac\u00admedata", "Ácmedätä", "\u0430cmed\u0430ta", "AskAcme-Data"]) {
      assert.equal(r.text(`Data from ${v} and others`), "Data from and others", v);
      assert.equal(r.blocked(v), true, v);
    }
    // ordinary words around a lone fragment stay
    assert.equal(r.text("acme, data and more"), "acme, data and more");
    assert.equal(r.text("Fresh data: acme-ish"), "Fresh data: acme-ish");
  });

  it("phrases and dotted names also go as slugs and with other separators; spaced ordinary words do not", () => {
    const r = createRedactor(["gizmo lake for agents", "gizmo.swaps", "zz.fake_events"]);
    assert.equal(r.text("see gizmo-lake-for-agents-2026 now"), "see now");
    assert.equal(r.text("The Gizmo.Lake.For.Agents team"), "The team");
    assert.equal(r.text("slug gizmo-swaps-weekly here"), "slug here");
    assert.equal(r.text("from zz-fake-events-v2 and zz_fake_events"), "from and");
    assert.equal(r.text("Gizmo swaps rose"), "Gizmo swaps rose", "a dotted name is not two ordinary words");
    assert.equal(r.deep({ link: "https://news.example.org/gizmo-lake-for-agents-2026" }).link, null);
    assert.deepEqual(r.sources([{ title: "x", url: "https://news.example.org/zz-fake-events-v2" }]), []);
  });

  it("identifier terms match from a word's start in their variant forms, and anywhere as written", () => {
    const r = createRedactor(["find_web"]);
    assert.equal(r.text("see https://refind.web3.example/ now"), "see https://refind.web3.example/ now", "another word that only contains the letters stays");
    assert.equal(r.text("call find-web or findWeb or x_find_web_v2"), "call or or");
  });

  it("TOOLS_REDACT_KEEP still keeps whole ordinary words, matched like the terms", () => {
    const r = createRedactor(["acmedata"], ["Acmedatic"]);
    assert.equal(r.text("ACMEDATIC chains by Acme-Data"), "ACMEDATIC chains by");
    assert.equal(r.blocked("acmedatic design"), false);
  });

  it("deep: a key holding a term goes with its value", () => {
    const r = createRedactor(["acmedata"]);
    assert.deepEqual(r.deep({ acmedata_score: 1, ok: { "Acme-Data label": "x", n: 2 } }), { ok: { n: 2 } });
  });

  it("TOOLS_REDACT_TERMS is read folded", () => {
    assert.deepEqual(configuredTerms({ TOOLS_REDACT_TERMS: " ＡＣＭＥ , -Gizmo-, ab" }), ["acme", "gizmo"]);
  });

  it("format characters leave a source's text without a trace", () => {
    assert.equal(str("Ac\u200bme\u2060data\u202e "), "Acmedata");
    assert.equal(cleanText("Ac\u200bme\u00addata\u0007x", 80), "Acmedata x");
  });
});
