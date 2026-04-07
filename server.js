// server.js - 后端服务器
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

class BinanceFetcher {
    async getKlines(symbol = 'BTCUSDT', interval = '1h', startTime = null, endTime = null, limit = 1000) {
        const endpoint = 'https://api.binance.com/api/v3/klines';
        const params = { symbol, interval, limit };
        if (startTime) params.startTime = startTime;
        if (endTime) params.endTime = endTime;

        try {
            const response = await axios.get(endpoint, { params });
            return response.data.map(item => ({
                timestamp: item[0],
                openTime: new Date(item[0]),
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                volume: parseFloat(item[5])
            }));
        } catch (error) {
            console.error('获取数据失败:', error.message);
            return [];
        }
    }

    async getMultipleKlines(symbol = 'BTCUSDT', interval = '1h', daysBack = 365) {
        const allKlines = [];
        const limit = 1000;
        const endTime = Date.now();
        const totalKlinesNeeded = daysBack * 24;
        
        for (let offset = 0; offset < totalKlinesNeeded; offset += limit) {
            const startTime = endTime - (offset + limit) * 3600 * 1000;
            const klines = await this.getKlines(symbol, interval, startTime, offset === 0 ? endTime : null, limit);
            if (klines.length > 0) allKlines.push(...klines);
            await this.sleep(200);
        }
        
        const uniqueKlines = Array.from(new Map(allKlines.map(k => [k.timestamp, k])).values());
        uniqueKlines.sort((a, b) => a.timestamp - b.timestamp);
        return uniqueKlines;
    }

    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

class LadderDoubleKStrategy {
    constructor(initialCapital = 10000, riskPerTrade = 0.015, rewardRatio = 1.5, smaPeriod = 20) {
        this.initialCapital = initialCapital;
        this.capital = initialCapital;
        this.riskPerTrade = riskPerTrade;
        this.rewardRatio = rewardRatio;
        this.smaPeriod = smaPeriod;
        this.atrPeriod = 14;
        this.atrThreshold = 0.5;
        this.ladderCount = 3;
        
        this.trades = [];
        this.equityCurve = [];
        this.currentPosition = null;
        this.ladderHighs = [];
        this.ladderLows = [];
        
        this.stats = {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalProfit: 0,
            maxDrawdown: 0,
            peakCapital: initialCapital
        };
    }

    calculateSMA(prices, period) {
        if (prices.length < period) return null;
        const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
    }

    calculateATR(highs, lows, closes, period) {
        if (highs.length < period + 1) return null;
        const trValues = [];
        for (let i = 1; i <= period; i++) {
            const idx = highs.length - i;
            const tr = Math.max(highs[idx] - lows[idx], Math.abs(highs[idx] - closes[idx - 1]), Math.abs(lows[idx] - closes[idx - 1]));
            trValues.push(tr);
        }
        return trValues.reduce((a, b) => a + b, 0) / period;
    }

    isUptrend(close, sma, ladderLows) {
        if (close <= sma) return false;
        if (ladderLows.length < this.ladderCount) return true;
        const recentLows = ladderLows.slice(-this.ladderCount);
        for (let i = 1; i < recentLows.length; i++) {
            if (recentLows[i] <= recentLows[i - 1]) return false;
        }
        return true;
    }

    isDowntrend(close, sma, ladderHighs) {
        if (close >= sma) return false;
        if (ladderHighs.length < this.ladderCount) return true;
        const recentHighs = ladderHighs.slice(-this.ladderCount);
        for (let i = 1; i < recentHighs.length; i++) {
            if (recentHighs[i] >= recentHighs[i - 1]) return false;
        }
        return true;
    }

    canTrade(currentHour) {
        const utcHour = (currentHour - 8 + 24) % 24;
        return utcHour >= 8;
    }

    checkEntry(candle, prevCandle, prevPrevCandle, sma) {
        if (!this.canTrade(candle.openTime.getUTCHours())) return null;
        
        if (this.isUptrend(candle.close, sma, this.ladderLows)) {
            const breakHigh = Math.max(prevCandle.high, prevPrevCandle.high);
            if (candle.high > breakHigh) {
                const stopLoss = Math.min(prevCandle.low, prevPrevCandle.low, candle.low) - 1;
                const risk = candle.high - stopLoss;
                return {
                    type: 'long',
                    entryPrice: candle.high,
                    stopLoss: stopLoss,
                    takeProfit: candle.high + risk * this.rewardRatio,
                    risk: risk
                };
            }
        }
        
        if (this.isDowntrend(candle.close, sma, this.ladderHighs)) {
            const breakLow = Math.min(prevCandle.low, prevPrevCandle.low);
            if (candle.low < breakLow) {
                const stopLoss = Math.max(prevCandle.high, prevPrevCandle.high, candle.high) + 1;
                const risk = stopLoss - candle.low;
                return {
                    type: 'short',
                    entryPrice: candle.low,
                    stopLoss: stopLoss,
                    takeProfit: candle.low - risk * this.rewardRatio,
                    risk: risk
                };
            }
        }
        return null;
    }

    calculatePositionSize(riskAmount) {
        const riskCapital = this.capital * this.riskPerTrade;
        const positionSize = riskCapital / riskAmount;
        return Math.min(positionSize, this.capital / 2);
    }

    async backtest(klines, progressCallback) {
        const historicalATRs = [];
        const totalSteps = klines.length;
        
        for (let i = 50; i < klines.length - 1; i++) {
            const currentCandle = klines[i];
            const prevCandle = klines[i - 1];
            const prevPrevCandle = klines[i - 2];
            
            const closes = klines.slice(0, i + 1).map(k => k.close);
            const highs = klines.slice(0, i + 1).map(k => k.high);
            const lows = klines.slice(0, i + 1).map(k => k.low);
            
            const sma = this.calculateSMA(closes, this.smaPeriod);
            const atr = this.calculateATR(highs, lows, closes, this.atrPeriod);
            
            if (atr) historicalATRs.push(atr);
            
            if (sma && currentCandle.close > sma) {
                if (this.ladderLows.length === 0 || currentCandle.low > this.ladderLows[this.ladderLows.length - 1]) {
                    this.ladderLows.push(currentCandle.low);
                    if (this.ladderLows.length > 10) this.ladderLows.shift();
                }
            } else if (sma) {
                if (this.ladderHighs.length === 0 || currentCandle.high < this.ladderHighs[this.ladderHighs.length - 1]) {
                    this.ladderHighs.push(currentCandle.high);
                    if (this.ladderHighs.length > 10) this.ladderHighs.shift();
                }
            }
            
            // 更新持仓
            if (this.currentPosition) {
                const exitSignal = this.updatePosition(currentCandle);
                if (exitSignal) {
                    this.trades.push(exitSignal);
                    this.updateStats(exitSignal);
                    this.currentPosition = null;
                }
            }
            
            // 开新仓
            if (!this.currentPosition && sma) {
                const signal = this.checkEntry(currentCandle, prevCandle, prevPrevCandle, sma);
                if (signal) {
                    const positionSize = this.calculatePositionSize(signal.risk);
                    if (positionSize * signal.entryPrice <= this.capital) {
                        this.currentPosition = { ...signal, positionSize, entryTime: currentCandle.openTime };
                    }
                }
            }
            
            // 记录权益曲线
            let currentEquity = this.capital;
            if (this.currentPosition) {
                const unrealizedPnl = this.currentPosition.type === 'long'
                    ? (currentCandle.close - this.currentPosition.entryPrice) * this.currentPosition.positionSize
                    : (this.currentPosition.entryPrice - currentCandle.close) * this.currentPosition.positionSize;
                currentEquity = this.capital + unrealizedPnl;
            }
            
            this.equityCurve.push({
                time: currentCandle.openTime,
                equity: currentEquity,
                price: currentCandle.close
            });
            
            if (progressCallback && i % 100 === 0) {
                progressCallback((i / totalSteps) * 100);
            }
        }
        
        return this.getResults();
    }

    updatePosition(candle) {
        if (!this.currentPosition) return null;
        
        let exitPrice = null;
        let exitReason = null;
        
        if (this.currentPosition.type === 'long') {
            if (candle.low <= this.currentPosition.stopLoss) {
                exitPrice = this.currentPosition.stopLoss;
                exitReason = 'stop_loss';
            } else if (candle.high >= this.currentPosition.takeProfit) {
                exitPrice = this.currentPosition.takeProfit;
                exitReason = 'take_profit';
            }
        } else {
            if (candle.high >= this.currentPosition.stopLoss) {
                exitPrice = this.currentPosition.stopLoss;
                exitReason = 'stop_loss';
            } else if (candle.low <= this.currentPosition.takeProfit) {
                exitPrice = this.currentPosition.takeProfit;
                exitReason = 'take_profit';
            }
        }
        
        if (exitPrice) {
            const pnl = this.currentPosition.type === 'long'
                ? (exitPrice - this.currentPosition.entryPrice) * this.currentPosition.positionSize
                : (this.currentPosition.entryPrice - exitPrice) * this.currentPosition.positionSize;
            
            this.capital += pnl;
            
            return {
                ...this.currentPosition,
                exitPrice,
                exitTime: candle.openTime,
                pnl,
                exitReason
            };
        }
        return null;
    }

    updateStats(trade) {
        this.stats.totalTrades++;
        if (trade.pnl > 0) {
            this.stats.winningTrades++;
            this.stats.totalProfit += trade.pnl;
        } else {
            this.stats.losingTrades++;
            this.stats.totalProfit += trade.pnl;
        }
        
        if (this.capital > this.stats.peakCapital) {
            this.stats.peakCapital = this.capital;
        }
        const drawdown = (this.stats.peakCapital - this.capital) / this.stats.peakCapital;
        if (drawdown > this.stats.maxDrawdown) {
            this.stats.maxDrawdown = drawdown;
        }
    }

    getResults() {
        const totalReturn = (this.capital - this.initialCapital) / this.initialCapital;
        const winRate = this.stats.totalTrades > 0 ? this.stats.winningTrades / this.stats.totalTrades : 0;
        
        return {
            smaPeriod: this.smaPeriod,
            initialCapital: this.initialCapital,
            finalCapital: this.capital,
            totalReturn: totalReturn,
            totalReturnPercent: (totalReturn * 100).toFixed(2),
            totalTrades: this.stats.totalTrades,
            winningTrades: this.stats.winningTrades,
            losingTrades: this.stats.losingTrades,
            winRate: (winRate * 100).toFixed(2),
            totalProfit: this.stats.totalProfit,
            maxDrawdown: (this.stats.maxDrawdown * 100).toFixed(2),
            equityCurve: this.equityCurve,
            trades: this.trades
        };
    }
}

// API路由
app.get('/api/backtest', async (req, res) => {
    const { ma_period = '20', days = '180', risk = '0.015', reward = '1.5' } = req.query;
    
    const fetcher = new BinanceFetcher();
    const strategy = new LadderDoubleKStrategy(
        10000, 
        parseFloat(risk), 
        parseFloat(reward), 
        parseInt(ma_period)
    );
    
    try {
        const klines = await fetcher.getMultipleKlines('BTCUSDT', '1h', parseInt(days));
        const result = await strategy.backtest(klines);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/compare', async (req, res) => {
    const { days = '180' } = req.query;
    const fetcher = new BinanceFetcher();
    
    try {
        const klines = await fetcher.getMultipleKlines('BTCUSDT', '1h', parseInt(days));
        
        const strategy10 = new LadderDoubleKStrategy(10000, 0.015, 1.5, 10);
        const strategy20 = new LadderDoubleKStrategy(10000, 0.015, 1.5, 20);
        
        const result10 = await strategy10.backtest(klines);
        const result20 = await strategy20.backtest(klines);
        
        res.json({ ma10: result10, ma20: result20 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});