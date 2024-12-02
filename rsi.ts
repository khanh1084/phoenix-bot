import axios from "axios";
import { RSI, WMA, EMA } from "technicalindicators";
import { placeOrder } from "./functions";
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { MarketState, Side } from "@ellipsis-labs/phoenix-sdk";
import { config } from "./config";
import { EventEmitter } from "events";
import WebSocket from "ws";

const BASE_API_URL = "https://api.binance.com";
const BASE_WS_URL = "wss://stream.binance.com:9443";
const MAX_CANDLE_STICKS_LENGTH = 200;

let candleSticks: any[] = [];
let activeCandleStickWebSockets: WebSocket[] = [];
let activePriceWebSockets: WebSocket[] = [];
let priceStream: number = 0;
const events = new EventEmitter();

async function initFirstCandleSticks(symbol: string, interval: string) {
  try {
    const res = await axios.get(
      `${BASE_API_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${MAX_CANDLE_STICKS_LENGTH}`
    );
    let candleSticksAPI = candleStickFromAPIData(res.data);
    if (candleSticks.length === 0) {
      candleSticksAPI.pop();
      candleSticks = candleSticksAPI;
    } else {
      const firstCandleStick = candleSticks[0];
      candleSticksAPI = candleSticksAPI.filter(
        (candle) => candle.openTime > firstCandleStick.openTime
      );
      candleSticks = [...candleSticksAPI, ...candleSticks];
    }
    events.emit("ready", candleSticks);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to fetch candlesticks: ${error.message}`);
    } else {
      console.error(`Failed to fetch candlesticks: ${error}`);
    }
  }
}

function initCandleStickWS(symbol: string, interval: string) {
  // Close any existing WebSocket connections for candlesticks
  activeCandleStickWebSockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });
  activeCandleStickWebSockets = [];

  const ws = new WebSocket(
    `${BASE_WS_URL}/ws/${symbol.toLowerCase()}@kline_${interval}`
  );

  activeCandleStickWebSockets.push(ws);
  let reconnectAttempts = 0;
  let reconnecting = false;

  const reconnect = () => {
    if (reconnecting) return;
    reconnecting = true;
    reconnectAttempts++;
    setTimeout(() => {
      initCandleStickWS(symbol, interval);
      reconnecting = false;
    }, Math.min(1000 * reconnectAttempts, 30000));
  };

  const sendPing = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log("Sent ping to WebSocket server.");
    }
  };

  const pingInterval = setInterval(sendPing, 3 * 60 * 1000); // Send ping every 3 minutes

  ws.on("open", () => {
    console.log("WebSocket for fetching candlesticks connection opened.");
    reconnectAttempts = 0;
  });

  ws.on("message", (data: any) => {
    const message = JSON.parse(data.toString());
    // console.log("Received message:", message); // Log the received message
    if (message.ping) {
      ws.send(JSON.stringify({ pong: message.ping }));
    }
    if (!message.k || !message.k.x) return;
    const candle = candleSticksFromWSData(message);
    // console.log("Fetched candlestick:", candle); // Log the fetched candlestick
    const success = addCandleStick(candle);
    // console.log("Candlestick added:", success); // Log if the candlestick was added successfully
    if (!success) {
      console.log("Reconnecting due to candlestick not being added.");
      reconnect();
    }
    events.emit("newCandleStick", [...candleSticks]);
  });

  ws.on("close", () => {
    console.log(
      "WebSocket for fetching candlesticks connection closed. Starting connection again..."
    );
    clearInterval(pingInterval);
    reconnect();
  });

  ws.on("error", (err: any) => {
    console.error("WebSocket error:", err);
    clearInterval(pingInterval);
    reconnect();
  });
}

function initPriceWS(pair: string) {
  // Close any existing WebSocket connections for price
  activePriceWebSockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });
  activePriceWebSockets = [];

  const ws = new WebSocket(`${BASE_WS_URL}/ws/!ticker@arr`);
  activePriceWebSockets.push(ws);
  let reconnectAttempts = 0;
  let reconnecting = false;

  const reconnect = () => {
    if (reconnecting) return;
    reconnecting = true;
    reconnectAttempts++;
    console.info(`Reconnecting to price WS... Attempt ${reconnectAttempts}`);
    setTimeout(() => {
      initPriceWS(pair);
      reconnecting = false;
    }, Math.min(1000 * reconnectAttempts, 30000));
  };

  const sendPing = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log("Sent ping to WebSocket fetch price server.");
    }
  };

  const pingInterval = setInterval(sendPing, 3 * 60 * 1000); // Send ping every 3 minutes

  ws.on("message", (data: any) => {
    const messages = JSON.parse(data.toString());
    messages.forEach((message: any) => {
      const symbol = message.s;
      const price = parseFloat(message.c);
      if (pair === symbol) {
        priceStream = price;
      }
    });
  });

  ws.on("open", () => {
    console.info(`Price WebSocket for ${pair} connection opened.`);
    reconnectAttempts = 0;
  });

  ws.on("close", () => {
    console.warn(
      `Price WebSocket connection for ${pair} closed. Reconnecting...`
    );
    clearInterval(pingInterval);
    reconnect();
  });

  ws.on("error", (err) => {
    console.error(`Price WebSocket for ${pair} error:`, err);
    clearInterval(pingInterval);
    reconnect();
  });
}

function candleStickFromAPIData(data: any[]) {
  return data.map((value) => ({
    openTime: value[0],
    closeTime: value[6],
    openPrice: Number(value[1]),
    closePrice: Number(value[4]),
    highPrice: Number(value[2]),
    lowPrice: Number(value[3]),
  }));
}

function candleSticksFromWSData(message: any) {
  const k = message.k;
  return {
    openTime: k.t,
    closeTime: k.T,
    openPrice: Number(k.o),
    closePrice: Number(k.c),
    highPrice: Number(k.h),
    lowPrice: Number(k.l),
  };
}

function addCandleStick(candleStick: any) {
  if (candleSticks.length === 0) {
    candleSticks.push(candleStick);
    return true;
  }
  const lastCandleStick = candleSticks[candleSticks.length - 1];
  if (lastCandleStick.openTime >= candleStick.openTime) {
    console.log(
      "Candlestick not added: openTime is not greater than last candlestick's closeTime."
    );
    return false;
  }
  candleSticks.push(candleStick);
  if (candleSticks.length > MAX_CANDLE_STICKS_LENGTH) {
    candleSticks.shift();
  }
  return true;
}

async function calculateRSI(marketState: MarketState, period = 14) {
  if (candleSticks.length < period) {
    throw new Error("Not enough data to calculate RSI");
  }
  const closes = candleSticks.map((candle) => candle.closePrice);
  let allPrices = [...closes, priceStream];
  const rsiValues = RSI.calculate({ values: allPrices, period });
  for (let i = period; i < candleSticks.length; i++) {
    candleSticks[i].rsi = rsiValues[i - period];
  }
  return { rsi: rsiValues[rsiValues.length - 1], rsiValues: rsiValues };
}

function calculateWMA(data: number[], period: number) {
  const wmaValues = WMA.calculate({ values: data, period });
  return wmaValues[wmaValues.length - 1];
}

function calculateEMA(data: number[], period: number) {
  const emaValues = EMA.calculate({ values: data, period });
  return emaValues[emaValues.length - 1];
}

async function calculateIndicators(marketState: MarketState) {
  try {
    let { rsi, rsiValues } = await calculateRSI(marketState);
    let wma45 = rsiValues.length >= 45 ? calculateWMA(rsiValues, 45) : NaN;
    let ema9 = rsiValues.length >= 9 ? calculateEMA(rsiValues, 9) : NaN;
    return { rsi, wma: wma45, ema: ema9 };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error calculating indicators: ${error.message}`);
    } else {
      console.error(`Error calculating indicators: ${error}`);
    }
    return { rsi: NaN, wma: NaN, ema: NaN };
  }
}

export {
  initFirstCandleSticks,
  initCandleStickWS,
  initPriceWS,
  calculateRSI,
  calculateWMA,
  calculateEMA,
  calculateIndicators,
  events, // Export events
  priceStream,
};
