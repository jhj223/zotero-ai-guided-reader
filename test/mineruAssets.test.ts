import assert from "node:assert/strict";
import test from "node:test";
import { describeMinerUAsset } from "../src/core/mineruAssets";

test("maps nested MinerU image assets to safe cache names and aliases", () => {
  assert.deepEqual(describeMinerUAsset("paper-output/images/figure 1.png"), {
    zipPath: "paper-output/images/figure 1.png",
    aliases: [
      "paper-output/images/figure 1.png",
      "images/figure 1.png",
      "figure 1.png",
    ],
    storedName: "images__figure_1.png",
  });
});

test("rejects traversal, unsupported formats, and non-image folders", () => {
  assert.equal(describeMinerUAsset("../images/secret.png"), undefined);
  assert.equal(describeMinerUAsset("images/vector.svg"), undefined);
  assert.equal(describeMinerUAsset("assets/figure.png"), undefined);
});
