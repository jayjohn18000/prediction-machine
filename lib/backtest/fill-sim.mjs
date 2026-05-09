export function simulateMakerTouchFill(order, prevMidCents, curMidCents, conservative = true) {
  if (prevMidCents == null || curMidCents == null) return null;
  const px = Number(order.priceCents);
  const sz = Number(order.size);
  if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) return null;
  const edge = conservative ? 1 : 0;
  const side = String(order.mmSide ?? order.side ?? "");
  if (side === "yes_buy") {
    if (prevMidCents > px && curMidCents <= px - edge) {
      return { side: "yes_buy", priceCents: px, size: sz, maker: true };
    }
  } else if (side === "yes_sell") {
    if (prevMidCents < px && curMidCents >= px + edge) {
      return { side: "yes_sell", priceCents: px, size: sz, maker: true };
    }
  }
  return null;
}

export function simulateTakerCross(order, bookCents) {
  const sz = Math.max(0, Math.floor(Number(order.size ?? 0)));
  if (sz <= 0) return null;
  const side = String(order.mmSide ?? order.side ?? "");
  if (side === "yes_buy") {
    const ask = bookCents.bestAskCents;
    if (ask == null || !Number.isFinite(ask)) return null;
    return { side: "yes_buy", priceCents: Math.round(ask), size: sz, maker: false };
  }
  if (side === "yes_sell") {
    const bid = bookCents.bestBidCents;
    if (bid == null || !Number.isFinite(bid)) return null;
    return { side: "yes_sell", priceCents: Math.round(bid), size: sz, maker: false };
  }
  return null;
}

export function simulateFill(order, _snapshot, conservative = true) {
  if (order.kind === "taker") {
    return simulateTakerCross(order, {
      bestBidCents: order.bestBidCents,
      bestAskCents: order.bestAskCents,
    });
  }
  return simulateMakerTouchFill(order, order.prevMidCents, order.curMidCents, conservative);
}
