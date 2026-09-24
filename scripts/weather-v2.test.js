"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { buildPlugin } = require(path.join(core, "scripts/build-v2-plugin.cjs"));
const { PluginHost } = require(path.join(core, "dist/v2/host.js"));
const { artifactDir } = buildPlugin({
  id: "weather",
  packageRoot: path.resolve(__dirname, "../weather"),
  entry: "v2.ts",
});
const create = require(path.join(artifactDir, "index.cjs")).default;

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mi-box-weather-v2-")));
  const edits = [],
    requests = [];
  const fetch =
    options.fetch ||
    (async (url, init) => {
      requests.push({ url: String(url), init });
      const parsed = new URL(url);
      if (parsed.hostname.includes("translate"))
        return new Response(JSON.stringify([[["Test City", "测试城"]]]), { status: 200 });
      if (parsed.hostname.includes("geocoding"))
        return new Response(
          JSON.stringify({ results: [{ name: "Beijing", country: "China", latitude: 39.9, longitude: 116.4 }] }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify(
          options.weather || {
            current: {
              temperature_2m: 20,
              apparent_temperature: 19,
              relative_humidity_2m: 50,
              precipitation: 0,
              rain: 0,
              snowfall: 0,
              weather_code: 0,
              cloud_cover: 25,
              pressure_msl: 1012,
              wind_speed_10m: 8,
              wind_direction_10m: 0,
              wind_gusts_10m: 0,
            },
            daily: {
              temperature_2m_max: [25],
              temperature_2m_min: [12],
              sunrise: ["2026-09-06T05:30"],
              sunset: ["2026-09-06T18:30"],
            },
          },
        ),
        { status: 200 },
      );
    });
  const host = new PluginHost({
    storageRoot: root,
    ...(options.prefixes ? { prefixes: options.prefixes } : {}),
    logger: { info() {}, error() {} },
    http: { fetch },
    telegram: {
      async edit(message, text, options) {
        edits.push({ text, options });
      },
      async reply() {
        assert.fail("unexpected reply");
      },
      async invoke() {
        assert.fail("unexpected invoke");
      },
      async getReply() {
        return undefined;
      },
      async withClient() {
        assert.fail("unexpected native call");
      },
    },
  });
  await host.load(create());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    edits,
    requests,
    shutdown: () => host.shutdown(1000),
    run: text => host.dispatchPrimary({ id: 1, chatId: "1", senderId: "1", outgoing: true, text }),
  };
}

test("weather help and invalid input stay local", async t => {
  const f = await fixture(t);
  await f.run(".weather help");
  await f.run(".weather <bad>");
  assert.match(f.edits[0].text, /天气查询/);
  assert.match(f.edits.at(-1).text, /有效的城市名/);
});

test("weather queries geocoding and forecast through bounded HTTP", async t => {
  const f = await fixture(t);
  await f.run(".weather 北京");
  assert.match(f.edits.at(-1).text, /Beijing/);
  assert.match(f.edits.at(-1).text, /20°C/);
  assert.equal(f.edits.at(-1).options.parseMode, "html");
  assert.equal(new URL(f.requests[0].url).searchParams.get("count"), "10");
  assert.match(f.edits.map(x => x.text).join("\n"), /正在获取 Beijing, China/);
});

test("weather restores all legacy city mappings and managed Chinese translation fallback", async t => {
  const f = await fixture(t);
  await f.run(".weather 釜山");
  assert.equal(new URL(f.requests[0].url).searchParams.get("name"), "Busan");
  f.requests.length = 0;
  await f.run(".weather 测试城");
  assert.equal(new URL(f.requests[0].url).hostname, "translate.googleapis.com");
  assert.equal(new URL(f.requests[1].url).searchParams.get("name"), "Test City");
  assert.match(f.edits.map(x => x.text).join("\n"), /测试城 → Test City/);
});

test("weather accepts escaped punctuation and renders legacy fog and snow warnings", async t => {
  const f = await fixture(t, {
    weather: {
      current: {
        temperature_2m: 1,
        apparent_temperature: -1,
        relative_humidity_2m: 80,
        precipitation: 0,
        rain: 0,
        snowfall: 1,
        weather_code: 71,
        cloud_cover: 90,
        pressure_msl: 1000,
        wind_speed_10m: 5,
        wind_direction_10m: 360,
        wind_gusts_10m: 0,
      },
      daily: {
        temperature_2m_max: [2],
        temperature_2m_min: [-2],
        sunrise: ["2026-09-06T05:30"],
        sunset: ["2026-09-06T18:30"],
      },
    },
  });
  await f.run(".weather Xi'an");
  assert.equal(new URL(f.requests[0].url).searchParams.get("name"), "Xi'an");
  assert.match(f.edits.at(-1).text, /降雪预警/);
  assert.doesNotMatch(f.edits.at(-1).text, /undefined|NaN/);
});

test("weather renders complete help with the active non-default prefix", async t => {
  const f = await fixture(t, { prefixes: ["!"] });
  await f.run("!weather HELP extra");
  assert.match(f.edits[0].text, /!weather 北京/);
  assert.equal(f.requests.length, 0);
});

test("weather cancellation aborts a hanging managed request without a late failure receipt", async t => {
  let aborted = false;
  const f = await fixture(t, {
    fetch: async (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal.reason);
          },
          { once: true },
        );
      }),
  });
  const pending = f.run(".weather London");
  const cancelled = assert.rejects(pending, error => error?.code === "ABORTED");
  await new Promise(resolve => setImmediate(resolve));
  const stopped = await f.shutdown();
  await cancelled;
  assert.equal(stopped.completed, true);
  assert.equal(aborted, true);
  assert.equal(f.edits.filter(x => /失败/.test(x.text)).length, 0);
});
