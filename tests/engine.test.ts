import assert from "node:assert/strict";
import test from "node:test";
import { renderSkillPlaintext } from "../src/compliance/catalog.ts";
import { gateReview, reviewDeclaration } from "../src/compliance/engine.ts";
import { cleanSample, riskySample } from "../src/compliance/samples.ts";

const now = new Date("2026-03-11T08:00:00.000Z");

test("clean cotton shipment passes with no hits", () => {
  const result = reviewDeclaration(cleanSample, now);
  assert.equal(result.riskLevel, "pass");
  assert.deepEqual(result.keywordHits, []);
  assert.deepEqual(result.hsRisks, []);
  assert.deepEqual(result.missingFields, []);
});

test("risky sample holds on banned ivory and lists restricted, HS, tax, weight, and missing fields", () => {
  const result = reviewDeclaration(riskySample, now);
  assert.equal(result.riskLevel, "hold");
  assert.ok(result.keywordHits.some((hit) => hit.keyword === "象牙" && hit.list === "banned" && hit.field === "goodsName"));
  assert.ok(result.keywordHits.some((hit) => hit.keyword === "无人机" && hit.list === "restricted"));
  assert.ok(result.keywordHits.some((hit) => hit.keyword === "锂电池" && hit.field === "goodsName"));
  assert.ok(result.keywordHits.some((hit) => hit.keyword === "锂离子电池" && hit.field === "spec"));
  assert.ok(result.hsRisks.some((flag) => flag.code === "HS_WOOD"));
  assert.ok(result.hsRisks.some((flag) => flag.code === "HS_NAME_BATTERY"));
  assert.ok(result.hsRisks.some((flag) => flag.code === "HS_NAME_IVORY"));
  assert.ok(result.hsRisks.some((flag) => flag.code === "HS_NAME_DRONE"));
  assert.ok(result.hsRisks.some((flag) => flag.code === "TAX_CODE_FORMAT"));
  assert.ok(result.hsRisks.some((flag) => flag.code === "WEIGHT_NET_GT_GROSS"));
  assert.ok(result.missingFields.some((field) => field.field === "contractNo"));
  assert.ok(result.missingFields.some((field) => field.field === "licenseNo"));
  assert.equal(result.hsRisks.some((flag) => flag.code === "HS_FORMAT"), false);
});

test("arms chapter is a hold even when the goods name is bland", () => {
  const result = reviewDeclaration({
    ...cleanSample,
    goodsName: "金属零件",
    hsCode: "9304.00.00.00",
  }, now);
  assert.equal(result.riskLevel, "hold");
  assert.ok(result.hsRisks.some((flag) => flag.code === "HS_ARMS" && flag.level === "hold"));
});

test("dotted HS codes normalize before the 10-digit check", () => {
  const result = reviewDeclaration({ ...cleanSample, hsCode: "6109.10.00.00" }, now);
  assert.equal(result.riskLevel, "pass");
});

test("short HS code is a format risk and still matches the longest prefix", () => {
  const result = reviewDeclaration({ ...cleanSample, hsCode: "2844" }, now);
  assert.ok(result.hsRisks.some((flag) => flag.code === "HS_FORMAT"));
  assert.ok(result.hsRisks.some((flag) => flag.code === "HS_RADIOACTIVE"));
  assert.equal(result.hsRisks.some((flag) => flag.code === "HS_INORGANIC_CHEM"), false);
});

test("cross-border trade without a 19-digit tax code is flagged", () => {
  const result = reviewDeclaration({ ...cleanSample, tradeMode: "跨境电商" }, now);
  assert.ok(result.hsRisks.some((flag) => flag.code === "TAX_CODE_MISSING"));
});

test("empty declaration lists the required customs fields", () => {
  const result = reviewDeclaration({}, now);
  const fields = result.missingFields.map((field) => field.field);
  for (const field of ["goodsName", "hsCode", "consignee", "grossWeightKg", "packages"]) {
    assert.ok(fields.includes(field), field);
  }
  assert.equal(result.riskLevel, "review");
});

test("locked gate keeps counts and hides the keyword text", () => {
  const result = reviewDeclaration(riskySample, now);
  const gated = gateReview(result, false);
  assert.equal(gated.keywordHits, null);
  assert.equal(gated.keywordHitCount, result.keywordHits.length);
  assert.equal(JSON.stringify(gated).includes("象牙"), false);
  assert.equal(JSON.stringify(gated).includes("穿山甲"), false);
});

test("buyout plaintext includes the rule catalog and is not part of a review", () => {
  const text = renderSkillPlaintext().text;
  assert.match(text, /穿山甲/);
  assert.match(text, /customs-compliance-skill-plaintext-v1/);
  assert.match(text, /周期付费不提供这份明文/);
});
