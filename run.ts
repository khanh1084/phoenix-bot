import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionCtorFields,
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
    if (rsi > 75) {
      console.log(`RSI is above 75. Placing SELL limit order for ${pair}.`);
      side = Side.Ask;
      priceInTicks = Math.round(currentPrice * (1 + percentage / 100));
    } else if (rsi < 25) {
      console.log(`RSI is below 25. Placing BUY limit order for ${pair}.`);
      side = Side.Bid;
      priceInTicks = Math.round(currentPrice * (1 - percentage / 100));
    } else {
      if (sideway) {
        if (rsi >= Math.min(wma45, ema9) && rsi <= Math.max(wma45, ema9)) {
          console.log(`RSI is within the sideway range, ${pair}.`);
          if (wma45 < config.WMAlimitBuy) {
            console.log(
              `WMA45 is below the buy limit. Placing BUY limit order for ${pair}.\n`
            );
            side = Side.Bid;
            priceInTicks = Math.round(currentPrice * (1 - percentage / 100));
          } else {
            console.log(
              `WMA45 is not below the buy limit. No BUY limit order placed for ${pair}.\n`
            );
            await new Promise((resolve) =>
              setTimeout(resolve, timeCancel * 1000)
            );
            continue;
          }
        } else if (rsi > Math.max(wma45, ema9) && wma45 > config.WMAlimitSell) {
          console.log(
            `RSI is above the sideway range and WMA45 is above the sell limit. Placing SELL limit order for ${pair}.\n`
          );
          side = Side.Ask;
          priceInTicks = Math.round(currentPrice * (1 + percentage / 100));
        } else {
          console.log(
            `RSI is not within the sideway range and no conditions met for placing orders for ${pair}.\n`
          );
          await new Promise((resolve) =>
            setTimeout(resolve, timeCancel * 1000)
          );
          continue;
        }
      } else {
        if (wma45 < config.WMAlimitBuy && rsi < wma45) {
          console.log(
            `WMA45 is below the buy limit and RSI is below WMA45. Placing BUY limit order for ${pair}.\n`
          );
          side = Side.Bid;
          priceInTicks = Math.round(currentPrice * (1 - percentage / 100));
        } else if (wma45 > config.WMAlimitSell && rsi > wma45) {
          console.log(
            `WMA45 is above the sell limit and RSI is above WMA45. Placing SELL limit order for ${pair}.\n`
          );
          side = Side.Ask;
          priceInTicks = Math.round(currentPrice * (1 + percentage / 100));
        } else {
          console.log(`No conditions met for placing orders, ${pair}.\n`);
          await new Promise((resolve) =>
            setTimeout(resolve, timeCancel * 1000)
          );
          continue;
        }
      }
    }

    try {
      const placeOrderTx = await placeOrder(
        connection,
        marketState,
        trader,
        side,
        volume,
        priceInTicks
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
      const transaction = new Transaction({
        blockhash,
        lastValidBlockHeight,
        feePayer: trader.publicKey,
      }).add(placeOrderTx);

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
    } catch (error: any) {
      console.error(`Error placing order: ${error.message}`);
      if (error.message.includes("block height exceeded")) {
        console.log("Retrying transaction with a new blockhash...");
        continue;
      }
    }

    // Wait for the specified time
    await new Promise((resolve) => setTimeout(resolve, timeCancel * 1000));

    const cancelAllOrdersTx = await cancelAllOrders(
      marketState,
      trader.publicKey
    );

    const { blockhash: cancelBlockhash } =
      await connection.getRecentBlockhash();
    const cancelTransaction = new Transaction({
      recentBlockhash: cancelBlockhash,
      feePayer: trader.publicKey,
    } as TransactionCtorFields).add(cancelAllOrdersTx);

    const cancelAllOrdersTxId = await sendAndConfirmTransaction(
      connection,
      cancelTransaction,
      [trader],
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      }
    );
    console.log("All orders canceled. Transaction ID: ", cancelAllOrdersTxId);
  }
}

async function main() {
  const privateKeys = getPrivateKeysFromEnv();
  for (const privateKey of privateKeys) {
    const trader = Keypair.fromSecretKey(base58.decode(privateKey));
    console.log("Trader public key:", trader.publicKey.toString());

    const connection = new Connection("https://api.mainnet-beta.solana.com");
    const phoenix = await createPhoenixClient(connection);
    const marketState = await getMarketState(phoenix, "SOL/USDC");

    // Check user balance
    const { baseBalance, quoteBalance } = await checkUserBalance(
      connection,
      marketState,
      trader
    );
    console.log("Base balance: ", baseBalance);
    console.log("Quote balance: ", quoteBalance);

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

main().catch(console.error);
