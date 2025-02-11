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
  placeOrderWithSol,
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
      rsi,
      wma: wma45,
      ema: ema9,
    } = await calculateIndicators(marketState);
    console.log(
      `\nRSI: ${rsi}, WMA45: ${wma45}, EMA9: ${ema9}, Time: ${new Date().toLocaleString()}, Pair: ${pair}`
    );
    console.log(
      `WMAlimitSell: ${config.WMAlimitSell}, WMAlimitBuy: ${config.WMAlimitBuy}`
    );

    // Check if indicators are valid
    if (isNaN(rsi) || isNaN(wma45) || isNaN(ema9)) {
      console.log(
        "Not enough data to calculate indicators. Skipping this iteration."
      );
      await new Promise((resolve) => setTimeout(resolve, 30 * 1000));
      continue;
    }

    let side: Side;
    let priceInTicks: number;
    const currentPrice = priceStream;

    // Always place limit orders based on the current price and percentage

    // if (rsi > 75) {
    //   console.log(`RSI is above 75. Placing SELL limit order for ${pair}.`);
    //   side = Side.Ask;
    //   priceInTicks = marketState.floatPriceToTicks(currentPrice * (1 + percentage / 100));
    // } else if (rsi < 25) {
    //   console.log(`RSI is below 25. Placing BUY limit order for ${pair}.`);
    //   side = Side.Bid;
    //   priceInTicks = marketState.floatPriceToTicks(currentPrice * (1 - percentage / 100));
    // } else {
    //   if (sideway) {
    //     if (rsi >= Math.min(wma45, ema9) && rsi <= Math.max(wma45, ema9)) {
    //       console.log(`RSI is within the sideway range, ${pair}.`);
    //       if (wma45 < config.WMAlimitBuy) {
    //         console.log(
    //           `WMA45 is below the buy limit. Placing BUY limit order for ${pair}.\n`
    //         );
    //         side = Side.Bid;
    //         priceInTicks = marketState.floatPriceToTicks(currentPrice * (1 - percentage / 100));
    //       } else {
    //         console.log(
    //           `WMA45 is not below the buy limit. No BUY limit order placed for ${pair}.\n`
    //         );
    //         await new Promise((resolve) =>
    //           setTimeout(resolve, timeCancel * 1000)
    //         );
    //         continue;
    //       }
    //     } else if (rsi > Math.max(wma45, ema9) && wma45 > config.WMAlimitSell) {
    //       console.log(
    //         `RSI is above the sideway range and WMA45 is above the sell limit. Placing SELL limit order for ${pair}.\n`
    //       );
    //       side = Side.Ask;
    //       priceInTicks = marketState.floatPriceToTicks(currentPrice * (1 + percentage / 100));
    //     } else {
    //       console.log(
    //         `RSI is not within the sideway range and no conditions met for placing orders for ${pair}.\n`
    //       );
    //       await new Promise((resolve) =>
    //         setTimeout(resolve, timeCancel * 1000)
    //       );
    //       continue;
    //     }
    //   } else {
    //     if (wma45 < config.WMAlimitBuy && rsi < wma45) {
    //       console.log(
    //         `WMA45 is below the buy limit and RSI is below WMA45. Placing BUY limit order for ${pair}.\n`
    //       );
    //       side = Side.Bid;
    //       priceInTicks = marketState.floatPriceToTicks(currentPrice * (1 - percentage / 100));
    //     } else if (wma45 > config.WMAlimitSell && rsi > wma45) {
    //       console.log(
    //         `WMA45 is above the sell limit and RSI is above WMA45. Placing SELL limit order for ${pair}.\n`
    //       );
    //       side = Side.Ask;
    //       priceInTicks = marketState.floatPriceToTicks(currentPrice * (1 + percentage / 100));
    //     } else {
    //       console.log(`No conditions met for placing orders, ${pair}.\n`);
    //       await new Promise((resolve) =>
    //         setTimeout(resolve, timeCancel * 1000)
    //       );
    //       continue;
    //     }
    //   }
    // }

    side = Side.Ask;
    priceInTicks = marketState.floatPriceToTicks(
      currentPrice * (1 + percentage / 100)
    );
    console.log(`currentPrice: ${currentPrice}, priceInTicks: ${priceInTicks}`);
    const baseAtoms =
      parseFloat((volume / currentPrice).toFixed(8)) *
      10 ** marketState.data.header.baseParams.decimals;
    const quoteAtoms =
      volume * 10 ** marketState.data.header.quoteParams.decimals;
    const numBaseLots = marketState.baseAtomsToBaseLots(baseAtoms);
    const numQuoteLots = marketState.quoteAtomsToQuoteLots(quoteAtoms);
    console.log(`numBaseLots: ${numBaseLots}, numQuoteLots: ${numQuoteLots}`);

    // Ensure either numBaseLots or numQuoteLots is nonzero
    if (numBaseLots == 0 && numQuoteLots == 0) {
      console.error("Either numBaseLots or numQuoteLots must be nonzero.");
      await new Promise((resolve) => setTimeout(resolve, timeCancel * 1000));
      continue;
    }

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
    console.log(
      `solBalance: ${solBalance}, baseWalletBalance: ${baseWalletBalance}, quoteWalletBalance: ${quoteWalletBalance}`
    );
    console.log(
      `Placing order with side: ${Side[side]}, volume: ${volume}, priceInTicks: ${priceInTicks}`
    );

    // if (side === Side.Bid) {
    //   const requiredQuoteUnits = numQuoteLots * marketState.data.header.quoteLotSize;
    //   const requiredQuoteBalance = requiredQuoteUnits / 10 ** marketState.data.header.quoteParams.decimals;
    //   if (quoteWalletBalance < requiredQuoteBalance) {
    //   console.error("Error: Insufficient quote balance to place the order");
    //   console.log(`Wallet quote balance: ${quoteWalletBalance}, required: ${requiredQuoteBalance}`);
    //   }
    // }

    if (side === Side.Ask) {
      const requiredBaseUnits =
        numBaseLots * Number(marketState.data.header.baseLotSize);
      const requiredBaseBalance =
        requiredBaseUnits / 10 ** marketState.data.header.baseParams.decimals;
      if (baseWalletBalance < requiredBaseBalance) {
        console.error("Error: Insufficient base balance to place the order");
        console.log(
          `Wallet base balance: ${baseWalletBalance}, required: ${requiredBaseBalance}`
        );

        //   // Check if there is enough SOL to wrap into wSOL
        //   const requiredBaseUnits =
        //     (numBaseLots - baseWalletBalance) *
        //     Number(marketState.data.header.baseLotSize);
        //   const requiredSOL =
        //     requiredBaseUnits / 10 ** marketState.data.header.baseParams.decimals;
        //   if (solBalance >= requiredSOL) {
        //     console.log(`Wrapping ${requiredSOL} SOL into wSOL...`);
        //     try {
        //       await wrapToken(
        //         connection,
        //         trader,
        //         requiredSOL,
        //         new PublicKey("So11111111111111111111111111111111111111112"),
        //         "wSOL"
        //       );
        //     } catch (error) {
        //       console.error("Error wrapping SOL into wSOL:", error);
        //       await new Promise((resolve) =>
        //         setTimeout(resolve, timeCancel * 1000)
        //       );
        //       continue;
        //     }
        //   } else {
        //     console.error("Error: Insufficient SOL to wrap into wSOL");
        //     console.log(`SOL balance: ${solBalance}, required: ${requiredSOL}`);
        //     await new Promise((resolve) =>
        //       setTimeout(resolve, timeCancel * 1000)
        //     );
        //     continue;
        //   }
        // }
        // // After wrapping, check if baseWalletBalance is still insufficient
        // const { baseWalletBalance: updatedBaseBalance } = await checkUserBalance(
        //   connection,
        //   marketState,
        //   trader
        // );
        // if (updatedBaseBalance < requiredBaseBalance) {
        //   console.error(
        //     "Error: Still insufficient base balance. Skipping order."
        //   );
        //   await new Promise((resolve) => setTimeout(resolve, timeCancel * 1000));
        //   continue;
      }
    }

    try {
      const lots = side === Side.Ask ? numQuoteLots : numBaseLots;
      // const lots = numQuoteLots;
      if (side === Side.Ask) {
        console.log("Selling using placeOrderWithSol...");
        await placeOrderWithSol(
          connection,
          marketState,
          trader,
          side,
          lots,
          priceInTicks
        );
      } else {
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
      }
    } catch (error) {
      if (error instanceof SendTransactionError) {
        console.error("SendTransactionError:", error.message);
        console.error("Transaction logs:", await error.getLogs(connection));
      } else {
        console.error("Error placing order:", error);
      }
    }

    const currentOrders = await getCurrentOrders(marketState, trader.publicKey);
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
