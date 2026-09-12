const assert = require("node:assert/strict");
const {mkdtempSync, readFileSync, rmSync, writeFileSync} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require(path.resolve(__dirname, "../../TeleBox-Core/node_modules/esbuild"));

const roots = ["t", "tts", "speedlink", "speedtest"];

function loadHelper(root, directory) {
  const source = path.resolve(__dirname, "..", root, "v2", "io.ts");
  const output = path.join(directory, `${root}.cjs`);
  const compiled = esbuild.transformSync(readFileSync(source, "utf8"), {loader: "ts", format: "cjs", target: "node24"});
  writeFileSync(output, compiled.code);
  return require(output).writeAll;
}

for (const root of roots) {
  test(`${root} retries short file writes without losing bytes`, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), `part5-${root}-write-`));
    try {
      const writeAll = loadHelper(root, directory);
      const received = [];
      let calls = 0;
      await writeAll({async write(buffer, offset, length, position) {
        assert.equal(position, null);
        const bytesWritten = Math.min(length, ++calls % 2 ? 2 : 1);
        received.push(...buffer.subarray(offset, offset + bytesWritten));
        return {bytesWritten, buffer};
      }}, Uint8Array.from([1, 2, 3, 4, 5, 6, 7]));
      assert.deepEqual(received, [1, 2, 3, 4, 5, 6, 7]);
      assert.ok(calls > 1);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test(`${root} rejects a zero-progress file write`, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), `part5-${root}-write-`));
    try {
      const writeAll = loadHelper(root, directory);
      await assert.rejects(writeAll({async write(buffer) { return {bytesWritten: 0, buffer}; }}, Uint8Array.of(1)),
        /invalid progress/);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
}
