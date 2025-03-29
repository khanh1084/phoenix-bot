import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  SendTransactionError,
  ComputeBudgetProgram,
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
import {
  getCancelOrderParamsFromL3Order,
  createCancelMultipleOrdersByIdInstruction,
} from "@ellipsis-labs/phoenix-sdk";
import { toBN, toNum } from "@ellipsis-labs/phoenix-sdk";

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

export async function cancelAllOrders(
  marketState: MarketState,
  traderPublicKey: PublicKey
): Promise<TransactionInstruction> {
  const currentOrders = await getCurrentOrders(marketState, traderPublicKey);
  if (currentOrders.length === 0) {
    throw new Error("No open orders to cancel");
  }

  const cancelParams = currentOrders.map((order) =>
    getCancelOrderParamsFromL3Order(order)
  );

  return createCancelMultipleOrdersByIdInstruction(
    {
      phoenixProgram: Phoenix.PROGRAM_ID,
      logAuthority: Phoenix.getLogAuthority(),
      market: marketState.address,
      trader: traderPublicKey,
      baseAccount: marketState.getBaseAccountKey(traderPublicKey),
      quoteAccount: marketState.getQuoteAccountKey(traderPublicKey),
      baseVault: marketState.getBaseVaultKey(),
      quoteVault: marketState.getQuoteVaultKey(),
      tokenProgram: TOKEN_PROGRAM_ID,
    },
    {
      params: { orders: cancelParams },
    }
  );
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
        priceInTicks: toBN(orderId.priceInTicks),
        side: Phoenix.Side.Bid,
        sizeInBaseLots: toBN(order.numBaseLots),
        makerPubkey: traderPublicKey.toString(),
        orderSequenceNumber: toBN(orderId.orderSequenceNumber),
        lastValidSlot: toBN(order.lastValidSlot),
        lastValidUnixTimestampInSeconds: toBN(
          order.lastValidUnixTimestampInSeconds
        ),
      });
    }
  }

  for (const [orderId, order] of asks) {
    if (order.traderIndex.toString() === traderIndex.toString()) {
      orders.push({
        priceInTicks: toBN(orderId.priceInTicks),
        side: Phoenix.Side.Ask,
        sizeInBaseLots: toBN(order.numBaseLots),
        makerPubkey: traderPublicKey.toString(),
        orderSequenceNumber: toBN(orderId.orderSequenceNumber),
        lastValidSlot: toBN(order.lastValidSlot),
        lastValidUnixTimestampInSeconds: toBN(
          order.lastValidUnixTimestampInSeconds
        ),
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
  const solBalance = solBalanceLamports / 1_000_000_000;

  const baseWalletBalance = baseBalanceValue.value.uiAmount ?? 0;
  const quoteWalletBalance = quoteBalanceValue.value.uiAmount ?? 0;

  const traderState: TraderState | undefined = marketState.data.traders.get(
    traderPublicKey.toString()
  );

  if (!traderState) {
    throw new Error(`Trader state not found for ${traderPublicKey.toString()}`);
  }

  const baseLotsLocked =
    Number(traderState.baseLotsLocked) *
    Number(marketState.data.header.baseLotSize);
  const baseLotsFree =
    Number(traderState.baseLotsFree) *
    Number(marketState.data.header.baseLotSize);
  const quoteLotsLocked =
    Number(traderState.quoteLotsLocked) *
    Number(marketState.data.header.quoteLotSize);
  const quoteLotsFree =
    Number(traderState.quoteLotsFree) *
    Number(marketState.data.header.quoteLotSize);

  const quoteLotsLockedInUnits =
    quoteLotsLocked / 10 ** marketState.data.header.quoteParams.decimals;
  const quoteLotsFreeInUnits =
    quoteLotsFree / 10 ** marketState.data.header.quoteParams.decimals;

  const baseLotsLockedInUnits =
    baseLotsLocked / 10 ** marketState.data.header.baseParams.decimals;
  const baseLotsFreeInUnits =
    baseLotsFree / 10 ** marketState.data.header.baseParams.decimals;

  const currentPrice = await getCurrentPrice(marketState);

  const baseWalletBalanceInUSD = baseWalletBalance * currentPrice;
  const baseLotsLockedInUSD = baseLotsLockedInUnits * currentPrice;
  const baseLotsFreeInUSD = baseLotsFreeInUnits * currentPrice;

  const totalBaseBalanceInUSD =
    baseWalletBalanceInUSD + baseLotsLockedInUSD + baseLotsFreeInUSD;
  const totalQuoteBalanceInUSD =
    quoteWalletBalance + quoteLotsLockedInUnits + quoteLotsFreeInUnits;

  return {
    solBalance: parseFloat(solBalance.toFixed(8)),
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

  const lamports = BigInt(Math.round(amount * 1_000_000_000));

  const solBalanceLamports = await connection.getBalance(traderPublicKey);
  if (solBalanceLamports < lamports) {
    throw new Error(
      `Insufficient SOL balance to wrap ${amount} SOL into wSOL. Available balance: ${
        solBalanceLamports / 1_000_000_000
      } SOL`
    );
  }

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: trader.publicKey,
      toPubkey: tokenAccount,
      lamports: lamports,
    })
  );

  if (mint.toString() === "So11111111111111111111111111111111111111112") {
    transaction.add(
      createSyncNativeInstruction(tokenAccount, TOKEN_PROGRAM_ID)
    );
  }

  try {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight + 150;
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
    throw error;
  }
}

export async function placeOrderWithSol(
  connection: Connection,
  marketState: MarketState,
  trader: Keypair,
  side: Side,
  volume: number,
  priceInTicks: number
): Promise<void> {
  const wsolMint = new PublicKey("So11111111111111111111111111111111111111112");
  const tokenAccount = getAssociatedTokenAddressSync(
    wsolMint,
    trader.publicKey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const transaction = new Transaction();
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }));

  const tokenAccountInfo = await connection.getAccountInfo(tokenAccount);
  if (!tokenAccountInfo) {
    console.log("Token account does not exist. Creating ATA...");
    transaction.add(
      createAssociatedTokenAccountInstruction(
        trader.publicKey,
        tokenAccount,
        trader.publicKey,
        wsolMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  const baseLotSize = Number(marketState.data.header.baseLotSize);
  const baseDecimals = marketState.data.header.baseParams.decimals;
  const solAmount = (volume * baseLotSize) / Math.pow(10, baseDecimals);
  const lamports = Math.round(solAmount * 1e9);

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: trader.publicKey,
      toPubkey: tokenAccount,
      lamports,
    })
  );

  transaction.add(createSyncNativeInstruction(tokenAccount, TOKEN_PROGRAM_ID));

  const orderPacket = Phoenix.getLimitOrderPacket({
    side,
    priceInTicks,
    numBaseLots: volume,
    selfTradeBehavior: Phoenix.SelfTradeBehavior.DecrementTake,
    matchLimit: undefined,
    clientOrderId: 0,
    useOnlyDepositedFunds: false,
    lastValidSlot: (await connection.getSlot()) + 150,
    lastValidUnixTimestampInSeconds: undefined,
    failSilientlyOnInsufficientFunds: false,
  });

  const orderInstruction = marketState.createPlaceLimitOrderInstruction(
    orderPacket,
    trader.publicKey
  );
  transaction.add(orderInstruction);

  const txid = await sendAndConfirmTransaction(
    connection,
    transaction,
    [trader],
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    }
  );
  console.log("Order placed successfully. Txid:", txid);
}

export async function placeOrderWithUSD(
  connection: Connection,
  marketState: MarketState,
  trader: Keypair,
  side: Side,
  quoteLots: number,
  priceInTicks: number,
  currentPrice: number
): Promise<void> {
  const quoteUnits = quoteLots * Number(marketState.data.header.quoteLotSize);
  const quoteAmount =
    quoteUnits / 10 ** marketState.data.header.quoteParams.decimals;

  const baseAmount = quoteAmount / currentPrice;

  const baseAtoms =
    baseAmount * 10 ** marketState.data.header.baseParams.decimals;
  const baseLots = marketState.baseAtomsToBaseLots(baseAtoms);

  const orderPacket = Phoenix.getLimitOrderPacket({
    side,
    priceInTicks,
    numBaseLots: baseLots,
    selfTradeBehavior: Phoenix.SelfTradeBehavior.DecrementTake,
    matchLimit: undefined,
    clientOrderId: 0,
    useOnlyDepositedFunds: false,
    lastValidSlot: (await connection.getSlot()) + 100,
    lastValidUnixTimestampInSeconds: undefined,
    failSilientlyOnInsufficientFunds: false,
  });

  const orderIx = marketState.createPlaceLimitOrderInstruction(
    orderPacket,
    trader.publicKey
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const transaction = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: trader.publicKey,
  });

  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }));
  transaction.add(orderIx);

  try {
    const txid = await sendAndConfirmTransaction(
      connection,
      transaction,
      [trader],
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      }
    );
    console.log("USD order placed successfully. Transaction ID:", txid);
  } catch (error) {
    console.error("Error sending USD order transaction:", error);
    throw error;
  }
}

export function calculateMinimumOrderVolume(
  marketState: MarketState,
  currentPrice: number
): number {
  const baseLotSize = Number(marketState.data.header.baseLotSize);
  const baseDecimals = marketState.data.header.baseParams.decimals;
  const minimumBaseAmount = baseLotSize / 10 ** baseDecimals;
  const minimumQuoteAmount = minimumBaseAmount * currentPrice;
  return minimumQuoteAmount * 1.05;
}
