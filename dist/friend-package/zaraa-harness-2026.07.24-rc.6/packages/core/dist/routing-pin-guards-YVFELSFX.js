import "./chunk-R5U7XKVJ.js";

// src/providers/routing-pin-guards.ts
function shouldSkipEconomicalChatRedirect(input) {
  if (input.routingReason.startsWith("hint:")) return true;
  return input.routingReason === "hard-pin" && input.chatModelBillingMode === "metered";
}
function shouldSkipCodingSpecialistOverride(input) {
  return input.codingModelBillingMode === "metered";
}
export {
  shouldSkipCodingSpecialistOverride,
  shouldSkipEconomicalChatRedirect
};
