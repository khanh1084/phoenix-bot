import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as Phoenix from "@ellipsis-labs/phoenix-sdk";
import { MarketState, Side } from "./types";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export async function createPhoenixClient(
  connection: Connection
): Promise<Phoenix.Client> {
  return await Phoenix.Client.create(connection);
}

export async function getMarketState(
  phoenix: Phoenix.Client,
  marketName: string
): Promise<MarketState> {
  const marketConfig = Array.from(phoenix.marketConfigs.values()).find(
    (market) => market.name === marketName
  );
  if (!marketConfig) {
    throw new Error("Market config not found");
  }
  const marketState = phoenix.marketStates.get(marketConfig.marketId);
  if (!marketState) {
    throw new Error("Market state not found");
  }
  return marketState;
}

export async function placeOrder(
  connection: Connection,
  marketState: MarketState,
  traderPublicKey: PublicKey,
  side: Side,
  numBaseLots: number,
  priceInTicks: number
): Promise<TransactionInstruction> {
  // Check user balance
  const { baseBalance, quoteBalance } = await checkUserBalance(
    connection,
    marketState,
    traderPublicKey
  );

  // Check if the trader has sufficient balance
  const requiredBalance = numBaseLots * priceInTicks;
  if (side === Phoenix.Side.Bid && quoteBalance < requiredBalance) {
    throw new Error("Insufficient quote balance to place the order");
  }
  if (side === Phoenix.Side.Ask && baseBalance < numBaseLots) {
    throw new Error("Insufficient base balance to place the order");
  }

  const orderPacket = Phoenix.getLimitOrderPacket({
    side,
    priceInTicks,
    numBaseLots,
    selfTradeBehavior: Phoenix.SelfTradeBehavior.DecrementTake,
    matchLimit: undefined,
    clientOrderId: 0,
    useOnlyDepositedFunds: false,
    lastValidSlot: undefined,
    lastValidUnixTimestampInSeconds: undefined,
    failSilientlyOnInsufficientFunds: false,
  });
  return marketState.createPlaceLimitOrderInstruction(
    orderPacket,
    traderPublicKey
  );
}

export async function cancelAllOrders(
  marketState: MarketState,
  traderPublicKey: PublicKey
): Promise<TransactionInstruction> {
  return marketState.createCancelAllOrdersInstruction(traderPublicKey);
}

export async function getCurrentPrice(
  marketState: MarketState
): Promise<number> {
  const ladder = marketState.getUiLadder();
  const bestBid = ladder.bids[0];
  const bestAsk = ladder.asks[0];
  return (bestBid.price + bestAsk.price) / 2;
}

export async function getCurrentOrders(
  marketState: MarketState,
  traderPublicKey: PublicKey
): Promise<Phoenix.L3Order[]> {
  const bids = marketState.data.bids;
  const asks = marketState.data.asks;
  const orders: Phoenix.L3Order[] = [];

  for (const [orderId, order] of bids) {
    if (order.traderIndex.toString() === traderPublicKey.toString()) {
      orders.push({
        priceInTicks: orderId.priceInTicks,
        side: Phoenix.Side.Bid,
        sizeInBaseLots: order.numBaseLots,
        makerPubkey: traderPublicKey.toString(),
        orderSequenceNumber: orderId.orderSequenceNumber,
        lastValidSlot: order.lastValidSlot,
        lastValidUnixTimestampInSeconds: order.lastValidUnixTimestampInSeconds,
      });
    }
  }

  for (const [orderId, order] of asks) {
    if (order.traderIndex.toString() === traderPublicKey.toString()) {
      orders.push({
        priceInTicks: orderId.priceInTicks,
        side: Phoenix.Side.Ask,
        sizeInBaseLots: order.numBaseLots,
        makerPubkey: traderPublicKey.toString(),
        orderSequenceNumber: orderId.orderSequenceNumber,
        lastValidSlot: order.lastValidSlot,
        lastValidUnixTimestampInSeconds: order.lastValidUnixTimestampInSeconds,
      });
    }
  }

  return orders;
}

export async function checkUserBalance(
  connection: Connection,
  marketState: MarketState,
  traderPublicKey: PublicKey
): Promise<{ baseBalance: number; quoteBalance: number }> {
  // Get the associated token addresses for the trader's base and quote accounts
  const baseMint = marketState.data.header.baseParams.mintKey;
  const quoteMint = marketState.data.header.quoteParams.mintKey;
  const baseAccount = getAssociatedTokenAddressSync(baseMint, traderPublicKey);
  const quoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    traderPublicKey
  );

  // Get the balances of the trader's base and quote accounts
  const baseBalance = await connection.getTokenAccountBalance(baseAccount);
  const quoteBalance = await connection.getTokenAccountBalance(quoteAccount);

  // Convert balances to human-readable format
  const baseBalanceReadable =
    (baseBalance.value.uiAmount ?? 0) /
    10 ** marketState.data.header.baseParams.decimals;
  const quoteBalanceReadable =
    (quoteBalance.value.uiAmount ?? 0) /
    10 ** marketState.data.header.quoteParams.decimals;

  return {
    baseBalance: baseBalanceReadable || 0,
    quoteBalance: quoteBalanceReadable || 0,
  };
}
