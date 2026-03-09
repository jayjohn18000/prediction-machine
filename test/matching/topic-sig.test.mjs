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

if (a1 !== a2) {
  console.error("FAIL: GOVPARTY vs ohio governor:", a1, "!==", a2);
  process.exit(1);
}
if (b1 !== b2) {
  console.error("FAIL: SENATE-TX vs texas senate:", b1, "!==", b2);
  process.exit(1);
}
console.log("D3 topic signature tests OK:", a1, b1);
