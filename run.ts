import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import base58 from "bs58";
import {
  createPhoenixClient,
  getMarketState,
  placeOrder,
  cancelAllOrders,
  getCurrentPrice,
  getCurrentOrders,
  checkUserBalance,
  wrapToken,
} from "./functions";
import { getPrivateKeysFromEnv } from "./env";
import { Side, MarketState } from "@ellipsis-labs/phoenix-sdk";
import {
  calculateIndicators,
  initCandleStickWS,
  initFirstCandleSticks,
  priceStream,
  initPriceWS,
} from "./rsi";
import { config } from "./config";
import { SendTransactionError } from "@solana/web3.js";

async function trade(
  connection: Connection,
  marketState: MarketState,
  trader: Keypair,
  pair: string,
  sideway: boolean,
  volume: number,
  percentage: number,
  timeCancel: number
) {
  while (true) {
    try {
      const currentOrders = await getCurrentOrders(
        marketState,
        trader.publicKey
      );
      console.log("Current orders:", currentOrders);
      if (currentOrders.length > 0) {
        let cancelAllOrdersTxId;
        try {
          const cancelAllOrdersTx = await cancelAllOrders(
            marketState,
            trader.publicKey
          );

          const {
            blockhash: cancelBlockhash,
            lastValidBlockHeight: cancelLastValidBlockHeight,
          } = await connection.getLatestBlockhash();
          const cancelTransaction = new Transaction({
            blockhash: cancelBlockhash,
            lastValidBlockHeight: cancelLastValidBlockHeight,
            feePayer: trader.publicKey,
          }).add(cancelAllOrdersTx);

          cancelAllOrdersTxId = await sendAndConfirmTransaction(
            connection,
            cancelTransaction,
            [trader],
            {
              commitment: "confirmed",
              preflightCommitment: "confirmed",
            }
          );
          console.log(
            "All orders canceled. Transaction ID: ",
            cancelAllOrdersTxId
          );

          // Verify that all orders are canceled
          const updatedOrders = await getCurrentOrders(
            marketState,
            trader.publicKey
          );
          console.log("Updated orders after cancel:", updatedOrders);
          if (updatedOrders.length > 0) {
            console.error("Error: Some orders were not canceled.");
          }
        } catch (error) {
          if (error instanceof SendTransactionError) {
            console.error("SendTransactionError:", error.message);
            console.error("Transaction logs:", await error.getLogs(connection));
          } else {
            console.error("Error canceling orders:", error);
          }
        }
      } else {
        console.log("No orders to cancel.");
      }
    } catch (error: any) {
      console.error(`Error checking orders: ${error.message}`);
    }

    const {
      solBalance,
      baseWalletBalance,
      quoteWalletBalance,
      baseOpenOrdersBalance,
      quoteOpenOrdersBalance,
      totalBaseBalance,
      totalQuoteBalance,
    } = await checkUserBalance(connection, marketState, trader);

    console.log("SOL balance: ", solBalance);
    console.log("Base wallet balance: ", baseWalletBalance);
    console.log("Quote wallet balance: ", quoteWalletBalance);
    console.log("Base open orders balance: ", baseOpenOrdersBalance);
    console.log("Quote open orders balance: ", quoteOpenOrdersBalance);
    console.log("Total base balance: ", totalBaseBalance);
    console.log("Total quote balance: ", totalQuoteBalance);

    const symbol = "SOLUSDC";
    const interval = "5m";

    // Initialize the WebSocket connection to fetch candlestick data
    initFirstCandleSticks(symbol, interval);
    initCandleStickWS(symbol, interval);
    initPriceWS(symbol);

    // Trade
    await trade(
      connection,
      marketState,
      trader,
      symbol,
      config.sideway,
      config.volume,
      config.percentage,
      config.cancelTime
    );

    // Check if the balance is sufficient
    const {
      solBalance,
      baseWalletBalance,
      quoteWalletBalance,
      baseOpenOrdersBalance,
      quoteOpenOrdersBalance,
      totalBaseBalance,
      totalQuoteBalance,
    } = await checkUserBalance(connection, marketState, trader);

    console.log(`Placing order with side: ${Side[side]}, volume: ${volume}, priceInTicks: ${priceInTicks}`);

    if (side === Side.Bid && quoteWalletBalance < numQuoteLots) {
      console.error("Error: Insufficient quote balance to place the order");
      console.log(`Wallet quote balance: ${quoteWalletBalance}, required: ${numQuoteLots}`);
      await new Promise((resolve) => setTimeout(resolve, timeCancel * 1000));
      continue;
    }

    if (side === Side.Ask && baseWalletBalance < numBaseLots) {
      console.error("Error: Insufficient base balance to place the order");
      console.log(`Wallet base balance: ${baseWalletBalance}, required: ${numBaseLots}`);
      
      // Check if there is enough SOL to wrap into wSOL
      const requiredBaseUnits = (numBaseLots - baseWalletBalance) * marketState.data.header.baseLotSize;
      const requiredSOL = requiredBaseUnits / 10 ** marketState.data.header.baseParams.decimals;
      if (solBalance >= requiredSOL) {
        console.log(`Wrapping ${requiredSOL} SOL into wSOL...`);
        await wrapToken(connection, trader, requiredSOL, new PublicKey("So11111111111111111111111111111111111111112"), "wSOL");
      } else {
        console.error("Error: Insufficient SOL to wrap into wSOL");
        console.log(`SOL balance: ${solBalance}, required: ${requiredSOL}`);
        await new Promise((resolve) => setTimeout(resolve, timeCancel * 1000));
        continue;
      }
    }

    try {
      const lots = side === Side.Ask ? numQuoteLots : numBaseLots;
      // const lots = numQuoteLots;
      const placeOrderTx = await placeOrder(
        connection,
        marketState,
        trader,
        side,
        lots,
        priceInTicks
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
      const transaction = new Transaction({
        blockhash,
        lastValidBlockHeight,
        feePayer: trader.publicKey,
      })
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 500000, // Increase the limit as needed
        })
      )
      .add(placeOrderTx);

      const placeOrderTxId = await sendAndConfirmTransaction(
        connection,
        transaction,
        [trader],
        {
          commitment: "confirmed",
          preflightCommitment: "confirmed",
        }
      );

      console.log(`Order placed. Transaction ID: ${placeOrderTxId}`);
    } catch (error) {
      if (error instanceof SendTransactionError) {
        console.error("SendTransactionError:", error.message);
        console.error("Transaction logs:", await error.getLogs(connection));
      } else {
        console.error("Error placing order:", error);
      }
    }

    const currentOrders = await getCurrentOrders(
        marketState,
        trader.publicKey
      );
      console.log("Current orders:", currentOrders.length);

    // Wait for the specified time
    await new Promise((resolve) => setTimeout(resolve, timeCancel * 1000));
  }
}

async function main() {
  const privateKeys = getPrivateKeysFromEnv();
  for (const privateKey of privateKeys) {
    const trader = Keypair.fromSecretKey(base58.decode(privateKey));
    console.log("Trader public key:", trader.publicKey.toString());

    const connection = new Connection("https://api.mainnet-beta.solana.com");
    console.log("Creating Phoenix client...");
    const phoenix = await createPhoenixClient(connection);
    console.log("Creating Phoenix client... Done");
    console.log("Getting market state...");
    const marketState = await getMarketState(phoenix, "SOL/USDC");
    console.log("Getting market state... Done");
    console.log("Getting user balance...");
    // Check user balance
    const {
      solBalance,
      baseWalletBalance,
      quoteWalletBalance,
      baseOpenOrdersBalance,
      quoteOpenOrdersBalance,
      totalBaseBalance,
      totalQuoteBalance,
    } = await checkUserBalance(connection, marketState, trader);

    console.log("SOL balance: ", solBalance);
    console.log("Base wallet balance: ", baseWalletBalance);
    console.log("Quote wallet balance: ", quoteWalletBalance);
    console.log("Base open orders balance: ", baseOpenOrdersBalance);
    console.log("Quote open orders balance: ", quoteOpenOrdersBalance);
    console.log("Total base balance: ", totalBaseBalance);
    console.log("Total quote balance: ", totalQuoteBalance);

    const symbol = "SOLUSDC";
    const interval = "5m";

    // Initialize the WebSocket connection to fetch candlestick data
    initFirstCandleSticks(symbol, interval);
    initCandleStickWS(symbol, interval);
    initPriceWS(symbol);

    // Trade
    await trade(
      connection,
      marketState,
      trader,
      symbol,
      config.sideway,
      config.volume,
      config.percentage,
      config.cancelTime
    );
  }
}

main().catch((err) => {
  console.error(err);
});