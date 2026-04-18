import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(__dirname, "fixtures", "golden");

test("golden fixtures directory has README and sample contract", () => {
  const readme = fs.readFileSync(path.join(goldenDir, "README.md"), "utf8");
  assert.ok(readme.includes("Golden fixtures"));
  const sample = JSON.parse(
    fs.readFileSync(path.join(goldenDir, "sample-metadata-shape.json"), "utf8"),
  );
  assert.ok(Array.isArray(sample.polymarket_metadata_fields));
});
