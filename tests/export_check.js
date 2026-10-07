/*
 * Check for the 📥 JSON export ("הורד הכל"), v7.35+.
 *
 * Boots a calculator build in jsdom against LIVE-captured API responses
 * (fixtures/export-live-2026-10-07: get-countries & co. plus one real
 * manual-site product search per SIM type, served for every ISO), triggers
 * the real export, captures the downloaded file, and checks what is in it.
 * Four server scenarios: normal, one that throttles bursts, per-country
 * transient + persistent failures, and a double-click.
 *
 * With two builds it is also a differential: every pre-v7.35 key of every
 * country row must be byte-identical between them — the change is additive.
 *
 * Usage:  npm i && node export_check.js <build.html> [<baseline.html>]
 *   ✓ pass   ✗ FAIL   ≈ fails on the baseline as expected (shows the bug)
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const FIX = path.join(__dirname, "fixtures", "export-live-2026-10-07");
const fx = name => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Ground truth straight from the captured get-countries response. */
const SOURCE_NETWORKS = Object.fromEntries(fx("get-countries.json").data.map(c => {
  let arr = [];
  try { arr = JSON.parse(c.network || "[]"); } catch (e) { /* none */ }
  return [c.iso_code, arr.filter(n => n && n.network_name)];
}));

/* A fake backend. throttleAbove: 503 any site search arriving while more
 * than N are in flight (a WAF/rate limit). failOnce / failAlways: sets of
 * "ISO:sim_type" that 503 on the first attempt / on every attempt. */
function makeServer(opts = {}) {
  const st = { inFlight: 0, peak: 0, searches: 0, seen: new Set() };
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const fail = () => ({ ok: false, status: 503, json: async () => ({}) });
  const fetch = async input => {
    const u = new URL(String(input));
    if (u.host === "app-link.simtlv.co.il") {
      const zone = u.searchParams.get("zone");
      const file = `${u.pathname.slice(1)}${zone ? "_" + zone : ""}.json`;
      return fs.existsSync(path.join(FIX, file)) ? ok(fx(file)) : ok([]);
    }
    if (u.pathname.endsWith("admin-ajax.php")) {
      if (u.searchParams.get("task") !== "search_packages") return ok({ success: false, data: {} });
      const key = `${u.searchParams.getAll("fly_countries[]")[0]}:${u.searchParams.get("sim_type")}`;
      st.searches++; st.inFlight++; st.peak = Math.max(st.peak, st.inFlight);
      try {
        await sleep(opts.latencyMs ?? 15);
        if (opts.throttleAbove != null && st.inFlight > opts.throttleAbove) return fail();
        if (opts.failAlways && opts.failAlways.has(key)) return fail();
        if (opts.failOnce && opts.failOnce.has(key) && !st.seen.has(key)) { st.seen.add(key); return fail(); }
        return ok(fx(`site_FR_${u.searchParams.get("sim_type")}.trim.json`)); // real markup, first 3 products — jsdom parses the full 100 KB page at ~10 MB heap per country
      } finally { st.inFlight--; }
    }
    return ok({});
  };
  return { fetch, st };
}

async function boot(file, server) {
  const downloads = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", () => {});
  const dom = new JSDOM(fs.readFileSync(file, "utf8"), {
    url: "https://calc.local/index.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = server.fetch; w.alert = () => {}; w.open = () => null;
      w.URL.createObjectURL = blob => { const id = "blob:" + downloads.length; downloads.push({ id, blob, revokedAt: null }); return id; };
      w.URL.revokeObjectURL = id => { const d = downloads.find(x => x.id === id); if (d) d.revokedAt = Date.now(); };
    }
  });
  const w = dom.window;
  for (let i = 0; i < 200 && !w.eval("typeof data !== 'undefined' && data.length > 0"); i++) await sleep(50);
  await sleep(400); // let the boot-time topup preload settle before measuring
  w.eval("window.__toasts=[];(function(){var t0=showCopyToast;showCopyToast=function(m){window.__toasts.push(String(m));return t0.apply(this,arguments);};})();");
  return { dom, w, downloads, server };
}

async function readBlob(w, blob) {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((res, rej) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(blob); });
}

/** Clicks 📥 JSON once and returns the parsed download. */
async function runExport(env) {
  const before = env.downloads.length;
  await env.w.eval("downloadAllJSON()");
  const d = env.downloads[before];
  if (!d) throw new Error("no download captured");
  return { json: JSON.parse(await readBlob(env.w, d.blob)), dl: d, revokedSync: d.revokedAt !== null };
}

const emptyBoth = r => !((r.plans.global_api.esim || []).length && (r.plans.global_api.physical_sim || []).length);

async function runFile(file) {
  const T = [];                      // [name, pass, detail, fix]
  const ok = (n, c, d = "", fix = true) => T.push([n, !!c, d, fix]);
  const safe = fn => { try { return fn(); } catch (e) { return undefined; } };

  /* — scenario A: a normal server — */
  const A = await boot(file, makeServer());
  const nData = A.w.eval("data.length");
  const a = await runExport(A);
  const rows = a.json.countries || [];
  ok("download is valid JSON with one row per country", rows.length === nData && nData > 100, `${rows.length}/${nData}`, false);

  let netRows = 0, netMismatch = [], total = 0, with5g = 0;
  rows.forEach(r => {
    const src = SOURCE_NETWORKS[r.iso] || [];
    total += src.length; if (src.some(n => n.is5G)) with5g++;
    const got = r.networks;
    if (!Array.isArray(got)) return;
    netRows++;
    const same = got.length === src.length && src.every((n, i) => got[i].network_name === n.network_name
      && got[i].is4G === !!n.is4G && got[i].is5G === !!n.is5G
      && got[i].generation === ([n.is4G ? "4G" : "", n.is5G ? "5G" : ""].filter(Boolean).join("/") || null));
    if (!same) netMismatch.push(r.iso);
  });
  ok("every country carries its cellular networks", netRows === rows.length, `${netRows}/${rows.length} rows have networks`);
  ok("network names + is4G/is5G + 4G/5G badge match the API exactly", netRows && !netMismatch.length, netMismatch.slice(0, 5).join(","));
  ok("summary counts networks and 5G countries", a.json.summary && a.json.summary.networks_total === total && a.json.summary.with_5g === with5g,
    a.json.summary ? `${a.json.summary.networks_total}/${total} networks, ${a.json.summary.with_5g}/${with5g} with 5G` : "no summary");

  const zoneBad = rows.filter(r => {
    const m = A.w.eval(`(function(){var c=data.find(function(x){return x.iso===${JSON.stringify(r.iso)}});return JSON.stringify([c.zone,c.esimZone,c.physicalZone]);})()`);
    return !r.zones || JSON.stringify([r.zones.general, r.zones.esim, r.zones.physical]) !== m
      || !r.site_zones || !("esim" in r.site_zones) || !("physical_sim" in r.site_zones);
  });
  ok("per-SIM-type zones (API list zones + site zones) on every row", !zoneBad.length, zoneBad.slice(0, 5).map(r => r.iso).join(","));

  const pseudo = A.w.eval("CATALOG_PSEUDO.length");
  ok("shop catalog, T-Mobile, Mobyx/נצח and catalog-only destinations are included",
    a.json.shop_catalog && a.json.shop_catalog.countries && a.json.shop_catalog.countries.length === A.w.eval("SPECIAL_CATALOG.countries.length")
    && a.json.tmobile && a.json.mobyx && Array.isArray(a.json.mobyx.immortal)
    && Array.isArray(a.json.catalog_only_destinations) && a.json.catalog_only_destinations.length === pseudo,
    `pseudo=${pseudo} got=${(a.json.catalog_only_destinations || []).length}`);

  const limit = safe(() => A.w.eval("EXPORT_SCAN_CONCURRENCY"));
  ok("site scans are paced (peak in-flight requests ≤ 2 × EXPORT_SCAN_CONCURRENCY)",
    limit && A.server.st.peak <= 2 * limit, `peak ${A.server.st.peak} simultaneous requests`);
  ok("the download's blob URL is not revoked synchronously", !a.revokedSync, a.revokedSync ? "revoked inside downloadJSON" : "");

  /* — scenario A2: a future country-model field reaches the file — */
  A.w.eval("data[0].__future_field = 42");
  const a2 = await runExport(A);
  ok("a NEW country-model field lands in other_fields automatically",
    a2.json.countries[0].other_fields && a2.json.countries[0].other_fields.__future_field === 42, "");
  A.w.eval("delete data[0].__future_field");

  /* — scenario A3: double click — */
  A.server.st.searches = 0;
  const dlBefore = A.downloads.length;
  await Promise.all([A.w.eval("downloadAllJSON()"), A.w.eval("downloadAllJSON()")]);
  ok("a double click runs ONE export (one scan pass, one file)",
    A.server.st.searches === 2 * nData && A.downloads.length - dlBefore === 1,
    `${A.server.st.searches} site requests (one pass = ${2 * nData}), ${A.downloads.length - dlBefore} files`);

  /* — scenario B: the server throttles bursts — */
  const B = await boot(file, makeServer({ throttleAbove: 12 }));
  const b = await runExport(B);
  const lost = b.json.countries.filter(emptyBoth);
  ok("throttling server: no country loses its site prices", lost.length === 0, `${lost.length}/${b.json.countries.length} countries came back empty`);

  /* — scenario C: one transient and one persistent per-country failure — */
  const C = await boot(file, makeServer({ failOnce: new Set(["DE:esim"]), failAlways: new Set(["JP:physical_sim"]) }));
  const c = await runExport(C);
  const de = c.json.countries.find(r => r.iso === "DE"), jp = c.json.countries.find(r => r.iso === "JP");
  ok("a transient failure is retried and recovered", de && de.plans.global_api.esim.length > 0 && de.scan && de.scan.ok && de.scan.attempts === 2,
    de ? `DE esim ${de.plans.global_api.esim.length} packages` : "no DE");
  const jpListed = c.json.summary && c.json.summary.scan_failed.some(f => f.iso === "JP" && f.errors.some(e => e.simType === "physical_sim"));
  const toast = C.w.eval("window.__toasts.join(' | ')");
  ok("a persistent failure is listed in summary.scan_failed and announced (the other SIM type kept)",
    jpListed && jp.plans.global_api.esim.length > 0 && /נכשלו/.test(toast), toast.slice(0, 120));

  await sleep(5300); // the deferred revoke fires
  ok("…and it IS revoked a few seconds later (no blob leak)", A.downloads[0].revokedAt !== null, "");

  [A, B, C].forEach(e => e.dom.window.close());
  return { T, rows };
}

const LEGACY = ["iso", "name", "old_zone", "global_zone", "credit_price_per_gb", "plans"];
const legacyOf = r => JSON.stringify(LEGACY.map(k => r[k]));

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("usage: node export_check.js <build.html> [<baseline.html>]"); process.exit(2); }
  let failed = 0; const runs = [];
  for (const [i, f] of files.entries()) {
    console.log(`\n══ ${path.basename(f)}${i ? "  (baseline)" : ""} ══`);
    const { T, rows } = await runFile(f);
    runs.push(rows);
    for (const [name, pass, detail, fix] of T) {
      const mark = pass ? "✓" : (i && fix ? "≈" : "✗ FAIL");
      console.log(` ${mark}  ${name}${detail ? "  — " + detail : ""}`);
      if (!pass && !(i && fix)) failed++;
    }
  }
  if (runs.length === 2) {
    const base = new Map(runs[1].map(r => [r.iso, legacyOf(r)]));
    const diff = runs[0].filter(r => base.get(r.iso) !== legacyOf(r)).map(r => r.iso);
    console.log(`\n══ differential: pre-v7.35 keys of every country row ══`);
    console.log(diff.length ? ` ✗ FAIL  ${diff.length} rows differ: ${diff.slice(0, 8).join(",")}` : ` ✓  all ${runs[0].length} rows byte-identical on ${LEGACY.join(", ")}`);
    if (diff.length || runs[0].length !== runs[1].length) failed++;
  }
  console.log(failed ? `\n✗ ${failed} failure(s)` : "\n✓ all green");
  process.exit(failed ? 1 : 0);
})();
