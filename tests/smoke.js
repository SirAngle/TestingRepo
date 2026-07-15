/*
 * Differential smoke harness for the SimTLV giga calculator.
 *
 * Boots an HTML build in jsdom with a stubbed fetch (realistic API shapes,
 * including a country whose pSIM zone differs from its eSIM zone), then
 * drives the app and asserts the critical business rules documented in the
 * maintenance guide. Run against two files, it also diffs their observable
 * outputs so a refactor can be proven behavior-identical.
 *
 * Usage:  node smoke.js <file.html> [<other.html>]
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

/* ---------- API stubs ---------- */

// Manual-site product HTML: one 5GB item with a pair deal, one 10GB item.
function productHtml(prefix) {
  return `
  <div class="esim-global-product-item">
    <div class="package-gb">5GB</div>
    <div class="package-days">30 ימים</div>
    <div class="price-wrap">55 ₪</div>
    <a class="buy-now-with-icon" data-id="${prefix}base5" href="https://simtlv.co.il/checkout/?add-to-cart=111&fly_countries=UZ&product_zone=PG_9"></a>
    <div class="buy-now-bundle-wrap">
      <span class="bundle-text">זוג ב 99 ₪</span>
      <a class="buy-now-bundle" data-id="${prefix}deal5" href="https://simtlv.co.il/checkout/?add-to-cart=112&fly_countries=UZ&quantity=2"></a>
    </div>
  </div>
  <div class="esim-global-product-item">
    <div class="package-gb">10GB</div>
    <div class="package-days">30 ימים</div>
    <div class="price-wrap">95 ₪</div>
    <a class="buy-now-with-icon" data-id="${prefix}base10" href="https://simtlv.co.il/checkout/?add-to-cart=113&fly_countries=UZ&product_zone=PG_9"></a>
  </div>`;
}

const topupHiddenBlock = `<div style="display:none">SIMType: V2\n[country_code] => REU\n[region_name] => Europe\ncase_TV: tv2</div>`;

function jsonResponse(obj) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
}

// Country fixtures. SG deliberately has pSIM zone 2 but general/eSIM zone 3
// (the documented Singapore precedent).
const COUNTRIES = [
  { iso_code: "US", country_name: "United States", hebrew_name: "ארצות הברית", zone: 1, price: 2.5 },
  { iso_code: "DE", country_name: "Germany",       hebrew_name: "גרמניה",       zone: 1, price: 2.2 },
  { iso_code: "FR", country_name: "France",        hebrew_name: "צרפת",         zone: 1, price: 2.3 },
  { iso_code: "JP", country_name: "Japan",         hebrew_name: "יפן",          zone: 2, price: 3.1 },
  { iso_code: "SG", country_name: "Singapore",     hebrew_name: "סינגפור",      zone: 3, price: 4.0 },
];

function makeFetchStub(log) {
  return function fetchStub(input) {
    const url = String(input);
    log.push(url);

    if (url.includes("/get-countries")) {
      return jsonResponse({ data: COUNTRIES });
    }
    if (url.includes("/get-physical-countries")) {
      // SG pSIM zone differs from its general zone (2 vs 3).
      return jsonResponse({ data: COUNTRIES.map(c => ({ iso_code: c.iso_code, zone: c.iso_code === "SG" ? 2 : c.zone })) });
    }
    if (url.includes("/get-payasugo-countries")) {
      return jsonResponse({ data: COUNTRIES.map(c => ({ iso_code: c.iso_code, zone: c.zone })) });
    }
    if (url.includes("/get-packages")) {
      const zone = Number(new URL(url).searchParams.get("zone"));
      if (zone > 3) return jsonResponse([]);
      return jsonResponse([
        { zone, data: 5,  price: 10 + zone, id: `etok${zone}x5` },
        { zone, data: 10, price: 18 + zone, id: `etok${zone}x10` },
      ]);
    }
    if (url.includes("/get-physical-packages")) {
      const zone = Number(new URL(url).searchParams.get("zone"));
      if (zone > 3) return jsonResponse([]);
      return jsonResponse([
        { zone, data_amount: "5GB",  price: 50 + zone, id: 500 + zone },
        { zone, data_amount: "10GB", price: 90 + zone, id: 900 + zone },
      ]);
    }
    if (url.includes("admin-ajax.php")) {
      const u = new URL(url);
      const task = u.searchParams.get("task");
      if (task === "search_packages") {
        const sim = u.searchParams.get("sim_type");
        return jsonResponse({ success: true, data: { zone: 9, products: productHtml(sim === "esim" ? "e" : "p") } });
      }
      if (task === "search_topup") {
        const iccid = u.searchParams.get("your_iccid") || "";
        const physical = iccid.startsWith("894310") || iccid.startsWith("893720") || iccid.startsWith("8948010000012")
          || iccid.startsWith("8948010000059") || iccid.startsWith("8948010000060") ? 1 : 0;
        return jsonResponse({ success: true, data: { zone: 9, search_physical: physical, products: productHtml("t") + topupHiddenBlock } });
      }
    }
    return jsonResponse({});
  };
}

/* ---------- Harness ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runFile(file) {
  const html = fs.readFileSync(file, "utf-8");
  const fetchLog = [];
  const alerts = [];
  const opened = [];       // window.open calls
  const navigations = [];  // background-window re-navigations

  const virtualConsole = new VirtualConsole(); // swallow jsdom noise
  virtualConsole.on("jsdomError", () => {});

  const dom = new JSDOM(html, {
    url: "https://calc.local/index.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = makeFetchStub(fetchLog);
      window.alert = msg => alerts.push(String(msg));
      window.open = (url, name) => {
        opened.push({ url: String(url), name });
        const bg = {
          closed: false,
          blur() {}, focus() {}, close() { this.closed = true; },
          location: {}
        };
        Object.defineProperty(bg.location, "href", {
          set(v) { navigations.push(String(v)); },
          get() { return ""; }
        });
        return bg;
      };
    }
  });

  const { window } = dom;
  const G = expr => window.eval(expr);
  await sleep(900); // let the boot IIFE finish against the sync stubs

  const R = {}; // observable results (diffed between builds)
  const T = []; // [name, pass, detail] assertions

  const ok = (name, cond, detail = "") => T.push([name, !!cond, detail]);

  /* -- boot & three-zone model -- */
  R.dataLen = G("data.length");
  R.sgZones = G("JSON.stringify(data.filter(c=>c.iso==='SG').map(c=>[c.zone,c.esimZone,c.physicalZone]))");
  ok("boot: 5 countries", R.dataLen === 5, R.dataLen);
  ok("three-zone: SG general 3 / esim 3 / psim 2", R.sgZones === "[[3,3,2]]", R.sgZones);
  R.sgPsimPlanZone = G("JSON.stringify(data.find(c=>c.iso==='SG').plans.physical.map(p=>p.appId))");
  ok("SG psim plans come from zone 2", R.sgPsimPlanZone === "[502,902]", R.sgPsimPlanZone);

  /* -- selection + direct payment links -- */
  G("addCountry(data.find(c=>c.iso==='US'))");
  G("addCountry(data.find(c=>c.iso==='JP'))");
  await sleep(200);
  R.orderLinkEsim5 = G("buildOrderLink('esim', 5)");
  R.genericLink = G("buildGenericAppLink()");
  ok("direct eSIM link: multi-ISO + token + ref",
    R.orderLinkEsim5 === "https://app.simtlv.co.il/US%2CJP/5gb/esim/etok2x5?ref=R41IMUNU", R.orderLinkEsim5);
  ok("generic chooser link", R.genericLink === "https://app.simtlv.co.il/US%2CJP?ref=R41IMUNU", R.genericLink);

  /* -- checkout URL grammar -- */
  R.checkoutBase = G("buildCheckoutUrl('https://simtlv.co.il/checkout/?add-to-cart=1', true, ['VN','KH'])");
  ok("checkout: pipes sorted, ref, empty_cart, qty 1",
    R.checkoutBase.includes("fly_countries=KH|VN") && R.checkoutBase.includes("ref=R41IMUNU")
    && R.checkoutBase.includes("empty_cart=true") && R.checkoutBase.includes("quantity=1"), R.checkoutBase);
  G("cartSettings.quantity = 3");
  R.checkoutQty3 = G("buildCheckoutUrl('https://simtlv.co.il/checkout/?add-to-cart=1', true, ['US'])");
  ok("checkout: base link carries cart qty", R.checkoutQty3.includes("quantity=3"), R.checkoutQty3);
  R.checkoutDeal = G("buildCheckoutUrl('https://simtlv.co.il/checkout/?add-to-cart=2', false, ['US'])");
  ok("checkout: deal link gets NO qty multiplier", !R.checkoutDeal.includes("quantity=3"), R.checkoutDeal);
  G("cartSettings.quantity = 1");

  /* -- deal no-multiplier through the order pipeline -- */
  const pkgJson = `{
    simType:'physical_sim', dataGB:5, validityDays:30,
    base:{quantity:1,totalILS:55,perUnitILS:55,productId:'b5',checkoutUrl:'https://simtlv.co.il/checkout/?add-to-cart=111'},
    deals:[{quantity:2,totalILS:99,perUnitILS:49.5,label:'זוג',productId:'d5',checkoutUrl:'https://simtlv.co.il/checkout/?add-to-cart=112'}],
    bestPerUnitILS:49.5
  }`;
  R.variantQty2 = G(`JSON.stringify((()=>{const v=chooseOrderVariant(${pkgJson},2);return [v.source,v.isBase,v.totalILS];})())`);
  ok("chooseOrderVariant: qty 2 → exact deal", R.variantQty2 === '["deal",false,99]', R.variantQty2);
  R.variantQty3 = G(`JSON.stringify((()=>{const v=chooseOrderVariant(${pkgJson},3);return [v.source,v.isBase,v.totalILS];})())`);
  ok("chooseOrderVariant: qty 3 → base ×3", R.variantQty3 === '["base",true,165]', R.variantQty3);

  R.itemUrlDeal = G(`buildOrderItemUrl({source:'deal',isBase:false,qty:2,checkoutUrl:'https://simtlv.co.il/checkout/?add-to-cart=112&quantity=2',isos:['US']}, 0)`);
  ok("order item: DEAL url forced to quantity=1 (no bundle multiplication)",
    R.itemUrlDeal.includes("quantity=1") && !R.itemUrlDeal.includes("quantity=2"), R.itemUrlDeal);
  R.itemUrlBaseFirst = G(`buildOrderItemUrl({source:'base',isBase:true,qty:3,checkoutUrl:'https://simtlv.co.il/checkout/?add-to-cart=111',isos:['US']}, 0)`);
  R.itemUrlBaseSecond = G(`buildOrderItemUrl({source:'base',isBase:true,qty:3,checkoutUrl:'https://simtlv.co.il/checkout/?add-to-cart=111',isos:['US']}, 1)`);
  ok("order item: empty_cart on FIRST item only",
    R.itemUrlBaseFirst.includes("empty_cart=true") && !R.itemUrlBaseSecond.includes("empty_cart"),
    R.itemUrlBaseSecond);
  ok("order item: base carries its qty", R.itemUrlBaseFirst.includes("quantity=3"), R.itemUrlBaseFirst);

  /* -- topup URL rules -- */
  R.v1Url = G(`rewritePhysicalTopupUrlForSelected('https://simtlv.co.il/checkout/?add-to-cart=9&fly_countries=UZ','psim_v1')`);
  ok("V1 topup: fly_countries=REUP (never a country)",
    R.v1Url.includes("fly_countries=REUP") && !R.v1Url.includes("fly_countries=UZ"), R.v1Url);
  R.v2Url = G(`rewritePhysicalTopupUrlForSelected('https://simtlv.co.il/checkout/?add-to-cart=9&fly_countries=UZ','psim_v2')`);
  // Selection is US (zone 1) + JP (zone 2); rule #4 says topups operate on
  // the HIGHEST-zone selection only → fly_countries=JP, probe ISO gone.
  ok("V2 topup: probe ISO scrubbed, highest-zone selection only",
    R.v2Url.includes("fly_countries=JP") && !R.v2Url.includes("UZ") && !R.v2Url.includes("US"), R.v2Url);
  ok("V2 topup: ref present", R.v2Url.includes("ref=R41IMUNU"), R.v2Url);

  G("setTopupCustomerIccid('8948010000012743142')"); // full pSIM V2 ICCID
  await sleep(50);
  R.autoSwitched = G("topupState.simVersion");
  ok("ICCID autodetect switched to psim_v2", R.autoSwitched === "psim_v2", R.autoSwitched);
  R.topupUrl = G(`buildTopupCheckoutUrl('https://simtlv.co.il/checkout/?add-to-cart=9&fly_countries=US', 1, true)`);
  ok("topup checkout: your_iccid + ref + empty_cart",
    R.topupUrl.includes("your_iccid=8948010000012743142") && R.topupUrl.includes("ref=R41IMUNU")
    && R.topupUrl.includes("empty_cart=true"), R.topupUrl);
  R.topupUrlQty = G(`buildTopupCheckoutUrl('https://simtlv.co.il/checkout/?add-to-cart=9', 1, false)`);
  ok("topup checkout: qty 1 → no quantity param", !R.topupUrlQty.includes("quantity="), R.topupUrlQty);

  /* -- ICCID detection table -- */
  const iccidSamples = [
    ["8943108169999022608", "psim_v1"],
    ["8943108166001515249", "psim_v1"],
    ["8937204017186230887", "psim_v2"],
    ["8948010000012743142", "psim_v2"],
    ["8948010000059957639", "psim_v2"],
    ["8948010000060024171", "psim_v2"],
    ["8948010000077791457", "esim_v3"],
    ["8948010000063363337", "esim_v3"],
    ["8948010000027769918", "esim_v3"],
    ["8948010000052116480", "esim_v3"],
    ["8948010010054000000", "esim_v3"],
    ["8948010000014000000", "esim_v3"],
    ["8948010000038000000", "esim_v3"],
    ["8948010000095000000", "esim_v3"],
    ["8999999999999999999", null],
    ["89480100000", null], // too short to disambiguate
  ];
  R.iccidDetect = G(`JSON.stringify(${JSON.stringify(iccidSamples.map(s => s[0]))}.map(detectSimTypeFromIccid))`);
  ok("ICCID prefix table (16 samples, longest-match, unknown→null)",
    R.iccidDetect === JSON.stringify(iccidSamples.map(s => s[1])), R.iccidDetect);

  /* -- canonical topup slots + red rows -- */
  R.topupRows = G(`(()=>{
    const pkg = ${pkgJson};
    const html = renderTopupProducts({packages:[Object.assign({},pkg,{simType:'topup'})]});
    const missing = (html.match(/is-missing/g)||[]).length;
    const hasRed = html.includes("לא קיים");
    const has5 = html.includes("5 גיגה – 30 ימים – ₪55");
    return JSON.stringify([missing, hasRed, has5]);
  })()`);
  // simplify ON hides slots 1+7 → canonical [2,3,5,10,15,20,25,50], 5 present → 7 red rows
  ok("topup grid: 7 red canonical slots + present 5GB row", R.topupRows === "[7,true,true]", R.topupRows);

  /* -- composite cart keys (package::iccid) -- */
  G(`orderPackageRegistry['tk_test'] = { simType:'topup', pkg: ${pkgJson}, result: {} }`);
  window.document.body.insertAdjacentHTML("beforeend", `<input id="qty_tk_test" value="1">`);
  G("topupState.batchMode = true; topupState.batchIccids = ['8948010000012743142','8948010000059957639','8948010000060024171']");
  G("setTopupOrderQuantity('tk_test')");
  R.cartKeys = G("JSON.stringify(orderBuilderItems.map(i=>i.key))");
  ok("batch topup: one line per ICCID, keyed pkg::iccid",
    R.cartKeys === JSON.stringify([
      "tk_test::8948010000012743142",
      "tk_test::8948010000059957639",
      "tk_test::8948010000060024171"]), R.cartKeys);
  R.cartIccids = G("JSON.stringify(orderBuilderItems.map(i=>i.topupIccid))");
  ok("batch topup: items carry their own ICCIDs",
    R.cartIccids.includes("8948010000059957639"), R.cartIccids);

  /* -- payload roundtrip -- */
  R.payloadRoundtrip = G(`JSON.stringify(decodeOrderPayload(encodeOrderPayload({a:1,he:'שלום עולם',items:[{qty:2}]})))`);
  ok("order payload roundtrip (UTF-8 safe)", R.payloadRoundtrip === '{"a":1,"he":"שלום עולם","items":[{"qty":2}]}', R.payloadRoundtrip);

  /* -- session persistence -- */
  G("renderAll()");
  R.session = G(`(()=>{const s=JSON.parse(localStorage.getItem('simtlv_session_v1'));return JSON.stringify([s.selectedIsos,s.activeTab,s.batchMode,s.orderBuilderItems.length]);})()`);
  ok("session persists selection/tab/batch/cart", R.session === '[["US","JP"],"basic",true,3]', R.session);

  /* -- simplify math -- */
  R.simplify = G("JSON.stringify([applySimplify(7.97), applySimplify(7.6), applySimplify(3.24), applySimplify(3.02)])");
  ok("applySimplify snapping", R.simplify === "[8,7.5,3,3]", R.simplify);

  /* -- region grouping -- */
  R.regions = G(`JSON.stringify(formatCountriesByRegion(data).split("\\n").map(l=>l.split(":")[0]))`);
  ok("region grouping order", R.regions === '["אירופה","צפון אמריקה","אסיה"]', R.regions);

  /* -- copy price-line format (en-dash, ₪ before number) -- */
  R.planLine = G(`formatGlobalPlanLine(${pkgJson})`);
  ok("copy format: en-dash + ₪ prefix + deal suffix",
    R.planLine === '5 גיגה – 30 ימים – ₪55 – זוג ב99 ש"ח (₪49.5 לכרטיס)', R.planLine);

  /* -- order runner: exactly ONE window, N-1 navigations -- */
  G("sleepOrder = () => Promise.resolve()"); // fast-forward pacing
  opened.length = 0; navigations.length = 0;
  await G(`startGeneratedOrderItems([
    {label:'a',qty:1,isBase:true,source:'base',checkoutUrl:'https://simtlv.co.il/checkout/?add-to-cart=1',isos:['US']},
    {label:'b',qty:1,isBase:true,source:'base',checkoutUrl:'https://simtlv.co.il/checkout/?add-to-cart=2',isos:['US']},
    {label:'c',qty:1,isBase:true,source:'base',checkoutUrl:'https://simtlv.co.il/checkout/?add-to-cart=3',isos:['US']}
  ])`).catch(() => {});
  await sleep(100);
  R.runnerOpens = opened.filter(o => o.name === "simtlv_bg_runner").length;
  R.runnerNavs = navigations.length;
  ok("runner: exactly one named background window", R.runnerOpens === 1, JSON.stringify(opened));
  ok("runner: N-1 background navigations", R.runnerNavs === 2, JSON.stringify(navigations));
  ok("runner: empty_cart only on first navigation",
    navigations[0]?.includes("empty_cart=true") && !navigations[1]?.includes("empty_cart"), JSON.stringify(navigations));

  /* -- referral code everywhere -- */
  R.refEverywhere = [R.orderLinkEsim5, R.genericLink, R.checkoutBase, R.v1Url, R.v2Url, R.topupUrl]
    .every(u => u.includes("R41IMUNU"));
  ok("referral code on every customer-facing URL", R.refEverywhere, "");

  dom.window.close();
  return { R, T };
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("usage: node smoke.js <file.html> [<other.html>]"); process.exit(2); }

  const runs = [];
  let failed = 0;
  for (const f of files) {
    console.log(`\n══ ${path.basename(f)} ══`);
    const { R, T } = await runFile(f);
    runs.push({ f, R });
    for (const [name, pass, detail] of T) {
      console.log(` ${pass ? "✓" : "✗ FAIL"}  ${name}${pass ? "" : "  → " + detail}`);
      if (!pass) failed++;
    }
    console.log(` (${T.filter(t => t[1]).length}/${T.length} passed)`);
  }

  if (runs.length === 2) {
    console.log(`\n══ differential: ${path.basename(runs[0].f)} vs ${path.basename(runs[1].f)} ══`);
    const keys = new Set([...Object.keys(runs[0].R), ...Object.keys(runs[1].R)]);
    let diffs = 0;
    for (const k of keys) {
      const a = JSON.stringify(runs[0].R[k]), b = JSON.stringify(runs[1].R[k]);
      if (a !== b) { diffs++; console.log(` ✗ ${k}:\n    old: ${a}\n    new: ${b}`); }
    }
    console.log(diffs ? ` ${diffs} DIFFERENCES` : " ✓ all observed outputs identical");
    if (diffs) failed += diffs;
  }

  process.exit(failed ? 1 : 0);
})();
