import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { describeMinerUProgress } from "../src/core/progressText";

test("maps each MinerU state to a Chinese status line", () => {
  assert.equal(describeMinerUProgress({ state: "idle" }, false), "尚未解析");
  assert.equal(describeMinerUProgress({ state: "pending" }, false), "排队中…");
  assert.equal(
    describeMinerUProgress({ state: "waiting-file" }, false),
    "正在上传 PDF…",
  );
  assert.equal(
    describeMinerUProgress({ state: "converting" }, false),
    "正在转换…",
  );
  assert.equal(describeMinerUProgress({ state: "running" }, false), "解析中…");
  assert.equal(describeMinerUProgress({ state: "failed" }, false), "解析失败");
});

test("shows page progress while running", () => {
  assert.equal(
    describeMinerUProgress(
      { state: "running", extractedPages: 3, totalPages: 10 },
      false,
    ),
    "解析中 3/10 页",
  );
});

test("the done state downloads first, then settles on parse-complete", () => {
  assert.equal(
    describeMinerUProgress({ state: "done" }, false),
    "正在下载解析结果…",
  );
  assert.equal(describeMinerUProgress({ state: "done" }, true), "解析完成");
  assert.equal(describeMinerUProgress({ state: "idle" }, true), "解析完成");
});

test("the status chip no longer leaks raw English progress messages", async () => {
  const source = await readFile(
    new URL("../src/ui/GuidedReaderApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /describeMinerUProgress/);
  assert.doesNotMatch(source, /progress\.message \|\| progress\.state/);
});
