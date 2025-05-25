import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '../exchange/exchange.service';
import { StrategyInterface, TradeSignal } from './interfaces/strategy.interfact';
import * as techIndicators from 'technicalindicators';

@Injectable()
export class TrendRsiStrategy implements StrategyInterface {
  private readonly logger = new Logger(TrendRsiStrategy.name);
  private symbol: string;
  private timeframe: string;
  private rsiPeriod: number;
  private rsiOverbought: number;
  private rsiOversold: number;
  private emaShortPeriod: number;
  private emaLongPeriod: number;
  
  constructor(
    private configService: ConfigService,
    private exchangeService: ExchangeService,
  ) {
    this.symbol = this.configService.get<string>('SYMBOL') || 'BTCUSDT';
    this.timeframe = this.configService.get<string>('TIMEFRAME') || '15m';
    this.rsiPeriod = parseInt(this.configService.get<string>('RSI_PERIOD') || '14');
    this.rsiOverbought = parseInt(this.configService.get<string>('RSI_OVERBOUGHT') || '70');
    this.rsiOversold = parseInt(this.configService.get<string>('RSI_OVERSOLD') || '30');
    this.emaShortPeriod = parseInt(this.configService.get<string>('EMA_SHORT_PERIOD') || '9');
    this.emaLongPeriod = parseInt(this.configService.get<string>('EMA_LONG_PERIOD') || '21');
  }

  async analyze(): Promise<TradeSignal> {
    try {
      const klines = await this.exchangeService.getKlines(this.timeframe, 200);
      console.log(klines)
      if (!klines || klines.length === 0) {
        return { action: 'HOLD', reason: 'Недостаточно данных для анализа' };
      }
      console.log(this.rsiOverbought)
      console.log(this.rsiOversold)
      // В V5 API klines возвращаются от новых к старым, переворачиваем для индикаторов (старые -> новые)
      const closes = klines.map(candle => parseFloat(candle[4])).reverse();
      
      const rsiValues = this.calculateRSI(closes, this.rsiPeriod);
      const emaShort = this.calculateEMA(closes, this.emaShortPeriod);
      const emaLong = this.calculateEMA(closes, this.emaLongPeriod);
      
      const lastRsi = rsiValues[rsiValues.length - 1];
      const prevRsi = rsiValues[rsiValues.length - 2];
      const lastEmaShort = emaShort[emaShort.length - 1];
      const lastEmaLong = emaLong[emaLong.length - 1];
      const prevEmaShort = emaShort[emaShort.length - 2];
      const prevEmaLong = emaLong[emaLong.length - 2];
      const currentPrice = closes[closes.length - 1];
      
      this.logger.debug(`RSI: ${lastRsi}, EMA Short: ${lastEmaShort}, EMA Long: ${lastEmaLong}, Price: ${currentPrice}`);
      
      if (
        prevEmaShort < prevEmaLong && 
        lastEmaShort > lastEmaLong && 
        lastRsi < this.rsiOversold
      ) {
        return {
          action: 'BUY',
          price: currentPrice,
          reason: `Сигнал на покупку: пересечение EMA (${this.emaShortPeriod}>${this.emaLongPeriod}) и RSI (${lastRsi.toFixed(2)}) в зоне перепроданности`,
        };
      }
      
      if (
        prevEmaShort > prevEmaLong && 
        lastEmaShort < lastEmaLong && 
        lastRsi > this.rsiOverbought
      ) {
        return {
          action: 'SELL',
          price: currentPrice,
          reason: `Сигнал на продажу: пересечение EMA (${this.emaShortPeriod}<${this.emaLongPeriod}) и RSI (${lastRsi.toFixed(2)}) в зоне перекупленности`,
        };
      }
      
      if (prevRsi < this.rsiOversold && lastRsi > this.rsiOversold && lastEmaShort > lastEmaLong) {
        return {
          action: 'BUY',
          price: currentPrice,
          reason: `Сигнал на покупку: RSI (${lastRsi.toFixed(2)}) вышел из зоны перепроданности и тренд восходящий`,
        };
      }
      
      if (prevRsi < this.rsiOverbought && lastRsi > this.rsiOverbought && lastEmaShort < lastEmaLong) {
        return {
          action: 'SELL',
          price: currentPrice,
          reason: `Сигнал на продажу: RSI (${lastRsi.toFixed(2)}) вошел в зону перекупленности и тренд нисходящий`,
        };
      }
      
      return { action: 'HOLD', reason: 'Нет четкого сигнала' };
    } catch (error) {
      this.logger.error(`Ошибка в анализе стратегии: ${error.message}`);
      return { action: 'HOLD', reason: 'Ошибка анализа' };
    }
  }

  private calculateRSI(prices: number[], period: number): number[] {
    const inputRSI = {
      values: prices,
      period: period,
    };
    return techIndicators.RSI.calculate(inputRSI);
  }

  private calculateEMA(prices: number[], period: number): number[] {
    const inputEMA = {
      values: prices,
      period: period,
    };
    return techIndicators.EMA.calculate(inputEMA);
  }
}