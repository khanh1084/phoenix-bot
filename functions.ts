import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as Phoenix from "@ellipsis-labs/phoenix-sdk";
import { MarketState, Side } from "@ellipsis-labs/phoenix-sdk";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

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
  trader: Keypair,
  side: Side,
  numBaseLots: number,
  priceInTicks: number
): Promise<TransactionInstruction> {
  const traderPublicKey = trader.publicKey;

  // Check user balance
  const { baseBalance, quoteBalance } = await checkUserBalance(
    connection,
    marketState,
    trader
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
    lastValidSlot: (await connection.getSlot()) + 100,
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
  trader: Keypair
): Promise<{ baseBalance: number; quoteBalance: number }> {
  const traderPublicKey = trader.publicKey;
  const baseMint = marketState.data.header.baseParams.mintKey;
  const quoteMint = marketState.data.header.quoteParams.mintKey;
  const baseAccount = getAssociatedTokenAddressSync(baseMint, traderPublicKey);
  const quoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    traderPublicKey
  );

  // Create associated token accounts if they do not exist
  const transaction = new Transaction();
  const baseAccountInfo = await connection.getAccountInfo(baseAccount);
  if (!baseAccountInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        traderPublicKey,
        baseAccount,
        traderPublicKey,
        baseMint
      )
    );
  }
  const quoteAccountInfo = await connection.getAccountInfo(quoteAccount);
  if (!quoteAccountInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        traderPublicKey,
        quoteAccount,
        traderPublicKey,
        quoteMint
      )
    );
  }

  if (transaction.instructions.length > 0) {
    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      await sendAndConfirmTransaction(connection, transaction, [trader]);
    } catch (error: any) {
      throw error;
    }
  }

  const baseBalanceValue = await connection.getTokenAccountBalance(baseAccount);
  const quoteBalanceValue = await connection.getTokenAccountBalance(
    quoteAccount
  );

  const baseBalance =
    (baseBalanceValue.value.uiAmount ?? 0) /
    10 ** marketState.data.header.baseParams.decimals;
  const quoteBalance =
    (quoteBalanceValue.value.uiAmount ?? 0) /
    10 ** marketState.data.header.quoteParams.decimals;

  return {
    baseBalance: baseBalance || 0,
    quoteBalance: quoteBalance || 0,
  };
}
