/**
 * D3 hard gate: topicSignature('GOVPARTY-OH-2026-REP') === topicSignature('ohio governor republican 2026')
 * and topicSignature('SENATE-TX-2026') === topicSignature('texas senate race 2026')
 */
import { extractTopicSignature } from "../../lib/matching/proposal-engine.mjs";

function topicSignature(input) {
  if (input.includes("-") && !input.includes(" ")) {
    return extractTopicSignature({ provider_market_ref: input });
  }
  return extractTopicSignature({ title: input });
}

const a1 = topicSignature("GOVPARTY-OH-2026-REP");
const a2 = topicSignature("ohio governor republican 2026");
const b1 = topicSignature("SENATE-TX-2026");
const b2 = topicSignature("texas senate race 2026");
const c1 = topicSignature("GOVPARTYRI-26-D");
const c2 = topicSignature("rhode island governor 2026");
const d1 = topicSignature("SENATEWV-26-R");
const d2 = topicSignature("west virginia senate race 2026");

if (a1 !== a2) {
  console.error("FAIL: GOVPARTY vs ohio governor:", a1, "!==", a2);
  process.exit(1);
}
if (b1 !== b2) {
  console.error("FAIL: SENATE-TX vs texas senate:", b1, "!==", b2);
  process.exit(1);
}
if (c1 !== c2) {
  console.error("FAIL: GOVPARTY compact RI vs rhode island governor:", c1, "!==", c2);
  process.exit(1);
}
if (d1 !== d2) {
  console.error("FAIL: SENATE compact WV vs west virginia senate:", d1, "!==", d2);
  process.exit(1);
}
console.log("D3 topic signature tests OK:", a1, b1, c1, d1);
