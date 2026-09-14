import assert from "node:assert/strict";
import { CompanyHistory, normalizeCompanyName } from "./company-history.js";

const h = new CompanyHistory(":memory:");
assert.equal(normalizeCompanyName("  outsChool  "), "outschool");
assert.equal(normalizeCompanyName("BDO   USA"), "bdo usa");
assert.equal(h.hasApplied("Outschool"), false);
assert.equal(h.markApplied("Outschool"), true);
assert.equal(h.markApplied(" OUTSCHOOL "), false); // no duplicate
assert.equal(h.hasApplied("outschool"), true);
assert.equal(h.markApplied("BDO USA"), true);
assert.equal(h.count(), 2);
console.log("history tests OK:", h.all().map((r) => `${r.company_name} -> ${r.normalized_name}`));
h.close();
