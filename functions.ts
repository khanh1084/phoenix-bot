import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  SendTransactionError,
} from "@solana/web3.js";
import * as Phoenix from "@ellipsis-labs/phoenix-sdk";
import { MarketState, Side } from "@ellipsis-labs/phoenix-sdk";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
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

import { SelfTradeBehavior, OrderPacket } from "@ellipsis-labs/phoenix-sdk";

export async function placeOrder(
  connection: Connection,
  marketState: MarketState,
  trader: Keypair,
  side: Side,
  numBaseLots: number,
  priceInTicks: number
): Promise<TransactionInstruction> {
  const traderPublicKey = trader.publicKey;

  const orderPacket: OrderPacket = getLimitOrderPacket({
    side,
    priceInTicks,
    numBaseLots,
    selfTradeBehavior: SelfTradeBehavior.CancelProvide,
    matchLimit: undefined,
    clientOrderId: 0,
    useOnlyDepositedFunds: true,
    lastValidSlot: (await connection.getSlot()) + 100,
    lastValidUnixTimestampInSeconds: undefined,
    failSilientlyOnInsufficientFunds: false,
  });

  try {
    return marketState.createPlaceLimitOrderWithFreeFundsInstruction(
      orderPacket,
      traderPublicKey
    );
  } catch (error) {
    console.error("Error creating place limit order instruction:", error);
    throw error;
  }
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

  const traderIndex = marketState.data.traderPubkeyToTraderIndex.get(
    traderPublicKey.toString()
  );
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
  solBalance: number;
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
  const baseAccount = getAssociatedTokenAddressSync(
    baseMint,
    traderPublicKey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const quoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    traderPublicKey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

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
  const quoteBalanceValue = await connection.getTokenAccountBalance(
    quoteAccount
  );
  const solBalanceLamports = await connection.getBalance(traderPublicKey);
  const solBalance = solBalanceLamports / 1_000_000_000; // Convert lamports to SOL

  const baseWalletBalance = baseBalanceValue.value.uiAmount ?? 0;
  const quoteWalletBalance = quoteBalanceValue.value.uiAmount ?? 0;

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

  return {
    solBalance: parseFloat(solBalance.toFixed(8)), // Convert lamports to SOL
    baseWalletBalance: parseFloat(baseWalletBalance.toFixed(8)),
    quoteWalletBalance: parseFloat(quoteWalletBalance.toFixed(8)),
    baseOpenOrdersBalance: parseFloat(
      (baseLotsLockedInUSD + baseLotsFreeInUSD).toFixed(8)
    ),
    quoteOpenOrdersBalance: parseFloat(
      (quoteLotsLockedInUnits + quoteLotsFreeInUnits).toFixed(8)
    ),
    totalBaseBalance: parseFloat(totalBaseBalanceInUSD.toFixed(8)),
    totalQuoteBalance: parseFloat(totalQuoteBalanceInUSD.toFixed(8)),
  };
}

export async function wrapToken(
  connection: Connection,
  trader: Keypair,
  amount: number,
  mint: PublicKey,
  tokenName: string
): Promise<void> {
  const traderPublicKey = trader.publicKey;
  const tokenAccount = getAssociatedTokenAddressSync(
    mint,
    traderPublicKey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const transaction = new Transaction();

  // Create associated token account if it does not exist
  const tokenAccountInfo = await connection.getAccountInfo(tokenAccount);
  if (!tokenAccountInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        traderPublicKey,
        tokenAccount,
        traderPublicKey,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Convert SOL to lamports and ensure it is an integer
  const lamports = BigInt(Math.round(amount * 1_000_000_000));

  const solBalanceLamports = await connection.getBalance(traderPublicKey);
  if (solBalanceLamports < lamports) {
    throw new Error(
      `Insufficient SOL balance to wrap ${amount} SOL into wSOL. Available balance: ${
        solBalanceLamports / 1_000_000_000
      } SOL`
    );
  }

  // Transfer SOL to the associated token account if the token is wSOL
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: traderPublicKey,
      toPubkey: tokenAccount,
      lamports: lamports, // Use BigInt for lamports
    })
  );

  // Sync the native account to update the balance if the token is wSOL
  if (mint.toString() === "So11111111111111111111111111111111111111112") {
    transaction.add(
      createSyncNativeInstruction(tokenAccount, TOKEN_PROGRAM_ID)
    );
  }

  // Send the transaction
  try {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight + 150; // Increase the block height limit
    transaction.feePayer = traderPublicKey;

    await sendAndConfirmTransaction(connection, transaction, [trader], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    console.log(`${amount} ${tokenName} has been added to your wallet.`);
  } catch (error) {
    if (error instanceof SendTransactionError) {
      console.error("SendTransactionError:", error.message);
      console.error("Transaction logs:", await error.getLogs(connection));
    } else {
      console.error("Error wrapping token:", error);
    }
    throw error; // Rethrow the error to handle it in the calling function
  }
}
function getLimitOrderPacket(arg0: {
  side: Phoenix.Side;
  priceInTicks: number;
  numBaseLots: number;
  selfTradeBehavior: Phoenix.SelfTradeBehavior;
  matchLimit: undefined;
  clientOrderId: number;
  useOnlyDepositedFunds: boolean; // This must be true for free funds instruction
  lastValidSlot: number;
  lastValidUnixTimestampInSeconds: undefined;
  failSilientlyOnInsufficientFunds: boolean;
}): OrderPacket {
  return {
    __kind: "ImmediateOrCancel",
    side: arg0.side,
    priceInTicks: arg0.priceInTicks,
    numBaseLots: arg0.numBaseLots,
    numQuoteLots: 0, // Add default value
    minBaseLotsToFill: 0, // Add default value
    minQuoteLotsToFill: 0, // Add default value
    selfTradeBehavior: arg0.selfTradeBehavior,
    matchLimit: arg0.matchLimit,
    clientOrderId: arg0.clientOrderId,
    useOnlyDepositedFunds: arg0.useOnlyDepositedFunds,
    lastValidSlot: arg0.lastValidSlot,
    lastValidUnixTimestampInSeconds: arg0.lastValidUnixTimestampInSeconds,
  };
}
