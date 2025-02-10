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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
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

  const traderIndex = marketState.data.traderPubkeyToTraderIndex.get(traderPublicKey.toString());
  if (traderIndex === undefined) {
    throw new Error(`Trader index not found for ${traderPublicKey.toString()}`);
  }

  for (const [orderId, order] of bids) {
    if (order.traderIndex.toString() === traderIndex.toString()) {
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
    if (order.traderIndex.toString() === traderIndex.toString()) {
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

import { TraderState } from "@ellipsis-labs/phoenix-sdk";

export async function checkUserBalance(
  connection: Connection,
  marketState: MarketState,
  trader: Keypair
): Promise<{
  baseWalletBalance: number;
  quoteWalletBalance: number;
  baseOpenOrdersBalance: number;
  quoteOpenOrdersBalance: number;
  totalBaseBalance: number;
  totalQuoteBalance: number;
}> {
  const traderPublicKey = trader.publicKey;
  const baseMint = marketState.data.header.baseParams.mintKey;
  const quoteMint = marketState.data.header.quoteParams.mintKey;
  const baseAccount = getAssociatedTokenAddressSync(baseMint, traderPublicKey, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const quoteAccount = getAssociatedTokenAddressSync(quoteMint, traderPublicKey, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  console.log("Base account:", baseAccount.toString());
  console.log("Quote account:", quoteAccount.toString());

  // Create associated token accounts if they do not exist
  const transaction = new Transaction();
  const baseAccountInfo = await connection.getAccountInfo(baseAccount);
  if (!baseAccountInfo) {
    console.log("Base account does not exist. Creating...");
    transaction.add(
      createAssociatedTokenAccountInstruction(
        traderPublicKey,
        baseAccount,
        traderPublicKey,
        baseMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  const quoteAccountInfo = await connection.getAccountInfo(quoteAccount);
  if (!quoteAccountInfo) {
    console.log("Quote account does not exist. Creating...");
    transaction.add(
      createAssociatedTokenAccountInstruction(
        traderPublicKey,
        quoteAccount,
        traderPublicKey,
        quoteMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
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
  const quoteBalanceValue = await connection.getTokenAccountBalance(quoteAccount);

  console.log("Base account balance value:", baseBalanceValue.value);
  console.log("Quote account balance value:", quoteBalanceValue.value);

  const baseWalletBalance = baseBalanceValue.value.uiAmount ?? 0;
  const quoteWalletBalance = quoteBalanceValue.value.uiAmount ?? 0;

  console.log("Raw base wallet balance:", baseWalletBalance);
  console.log("Raw quote wallet balance:", quoteWalletBalance);

  // Get trader state to calculate locked and free balances
  const traderState: TraderState | undefined = marketState.data.traders.get(
    traderPublicKey.toString()
  );

  if (!traderState) {
    throw new Error(`Trader state not found for ${traderPublicKey.toString()}`);
  }

  // Convert locked and free balances to their respective units
  const baseLotsLocked =
    Number(traderState.baseLotsLocked) * marketState.data.header.baseLotSize;
  const baseLotsFree =
    Number(traderState.baseLotsFree) * marketState.data.header.baseLotSize;
  const quoteLotsLocked =
    Number(traderState.quoteLotsLocked) * marketState.data.header.quoteLotSize;
  const quoteLotsFree =
    Number(traderState.quoteLotsFree) * marketState.data.header.quoteLotSize;

  // Convert quote lots to quote units
  const quoteLotsLockedInUnits =
    quoteLotsLocked / 10 ** marketState.data.header.quoteParams.decimals;
  const quoteLotsFreeInUnits =
    quoteLotsFree / 10 ** marketState.data.header.quoteParams.decimals;

  // Convert base lots to base units
  const baseLotsLockedInUnits =
    baseLotsLocked / 10 ** marketState.data.header.baseParams.decimals;
  const baseLotsFreeInUnits =
    baseLotsFree / 10 ** marketState.data.header.baseParams.decimals;

  console.log("Base lots locked in units:", baseLotsLockedInUnits);
  console.log("Base lots free in units:", baseLotsFreeInUnits);

  // Get current price of base token in USD
  const currentPrice = await getCurrentPrice(marketState);

  // Convert base balances to USD
  const baseWalletBalanceInUSD = baseWalletBalance * currentPrice;
  const baseLotsLockedInUSD = baseLotsLockedInUnits * currentPrice;
  const baseLotsFreeInUSD = baseLotsFreeInUnits * currentPrice;

  // Calculate total balances in USD
  const totalBaseBalanceInUSD =
    baseWalletBalanceInUSD + baseLotsLockedInUSD + baseLotsFreeInUSD;
  const totalQuoteBalanceInUSD =
    quoteWalletBalance + quoteLotsLockedInUnits + quoteLotsFreeInUnits;

  console.log("Base wallet balance in USD:", baseWalletBalanceInUSD);
  console.log("Total base balance in USD:", totalBaseBalanceInUSD);

  return {
    baseWalletBalance: parseFloat(baseWalletBalance.toFixed(8)),
    quoteWalletBalance: parseFloat(quoteWalletBalance.toFixed(8)),
    baseOpenOrdersBalance: parseFloat((baseLotsLockedInUSD + baseLotsFreeInUSD).toFixed(8)),
    quoteOpenOrdersBalance: parseFloat((quoteLotsLockedInUnits + quoteLotsFreeInUnits).toFixed(8)),
    totalBaseBalance: parseFloat(totalBaseBalanceInUSD.toFixed(8)),
    totalQuoteBalance: parseFloat(totalQuoteBalanceInUSD.toFixed(8)),
  };
}