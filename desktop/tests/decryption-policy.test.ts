import assert from "node:assert/strict";
import { test } from "node:test";
import { selectKugouProvider } from "../application/decryptionProviderPolicy";

test("酷狗优先选择主解密逻辑", () => {
  assert.equal(selectKugouProvider([{ kind: "primary", available: true }, { kind: "fallback", available: true }]).kind, "primary");
});

test("主逻辑明确不支持时才允许切换备用能力", () => {
  assert.equal(selectKugouProvider([{ kind: "primary", available: false, reason: "不支持此格式" }, { kind: "fallback", available: true }]).kind, "fallback");
  assert.equal(selectKugouProvider([{ kind: "primary", available: false, reason: "运行失败" }, { kind: "fallback", available: true }]).kind, "primary");
});
