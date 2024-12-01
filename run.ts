import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
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
import { getPrivateKeyFromEnv } from "./env";
import { Side } from "@ellipsis-labs/phoenix-sdk";

async function main() {
  const connection = new Connection("https://api.devnet.solana.com/");
  const trader = Keypair.fromSecretKey(base58.decode(getPrivateKeyFromEnv()));

  const phoenix = await createPhoenixClient(connection);
  const marketState = await getMarketState(phoenix, "SOL/USDC");

  // Check user balance
  const { baseBalance, quoteBalance } = await checkUserBalance(
    connection,
    marketState,
    trader.publicKey
  );
  console.log("Base balance: ", baseBalance);
  console.log("Quote balance: ", quoteBalance);

  // Place an order
  const side = Side.Bid; // or Side.Ask
  const numBaseLots = 100; // Number of base lots to trade
  const priceInTicks = 200; // Price in ticks

  try {
    const placeOrderTx = await placeOrder(
      connection,
      marketState,
      trader.publicKey,
      side,
      numBaseLots,
      priceInTicks
    );

    const placeOrderTxId = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(placeOrderTx),
      [trader]
    );
    console.log("Order placed. Transaction ID: ", placeOrderTxId);
  } catch (error: any) {
    console.error("Failed to place order:", error.message);
  }

  // Get current price
  const currentPrice = await getCurrentPrice(marketState);
  console.log("Current price: ", currentPrice);

  // Get current orders
  const currentOrders = await getCurrentOrders(marketState, trader.publicKey);
  console.log("Current orders: ", currentOrders);

  // Cancel all orders
  const cancelAllOrdersTx = await cancelAllOrders(
    marketState,
    trader.publicKey
  );
  const cancelAllOrdersTxId = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(cancelAllOrdersTx),
    [trader]
  );
  console.log("All orders canceled. Transaction ID: ", cancelAllOrdersTxId);
}

main().catch(console.error);
