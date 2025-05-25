import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '../exchange/exchange.service';
import { TrendRsiStrategy } from '../strategy/trend-rsi.strategy';

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);
  private symbol: string;
  private positionSize: string;
  private stopLossPercent: number;
  private takeProfitPercent: number;
  private maxOpenPositions: number;
  private isTrading: boolean = true;

  constructor(
    private configService: ConfigService,
    private exchangeService: ExchangeService,
    private trendRsiStrategy: TrendRsiStrategy,
  ) {
    this.symbol = this.configService.get<string>('SYMBOL') || 'BTCUSDT';
    this.positionSize = this.configService.get<string>('POSITION_SIZE') || '0.01';
    this.stopLossPercent = parseFloat(this.configService.get<string>('STOP_LOSS_PERCENT') || '1');
    this.takeProfitPercent = parseFloat(this.configService.get<string>('TAKE_PROFIT_PERCENT') || '2');
    this.maxOpenPositions = parseInt(this.configService.get<string>('MAX_OPEN_POSITIONS') || '1');
    
    this.logger.log(`Торговый сервис инициализирован для ${this.symbol}`);
    this.logger.log(`Размер позиции: ${this.positionSize} BTC`);
    this.logger.log(`Стоп-лосс: ${this.stopLossPercent}%, Тейк-профит: ${this.takeProfitPercent}%`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async executeTradingLogic() {
    if (!this.isTrading) {
      this.logger.debug('Торговля приостановлена');
      return;
    }
    
    try {
      const positions = await this.exchangeService.getPositions();
      const openPositionsCount = positions.filter(pos => parseFloat(pos.size) > 0).length;
      
      const signal = await this.trendRsiStrategy.analyze();
      this.logger.log(`Получен сигнал: ${signal.action} - ${signal.reason}`);
      
      if (openPositionsCount >= this.maxOpenPositions && (signal.action === 'BUY' || signal.action === 'SELL')) {
        this.logger.warn(`Достигнуто максимальное количество открытых позиций (${openPositionsCount}/${this.maxOpenPositions})`);
        return;
      }
      
      if (signal.action === 'BUY') {
        await this.openLongPosition(signal.price?.toString() || '');
      } else if (signal.action === 'SELL') {
        await this.openShortPosition(signal.price?.toString() || '');
      }
      
      await this.updatePositionProtection();
    } catch (error) {
      this.logger.error(`Ошибка в торговой логике: ${error.message}`);
    }
  }

  private async openLongPosition(price: string) {
    try {
      this.logger.log(`Открываем длинную позицию по ${this.symbol} с размером ${this.positionSize}`);
      
      const order = await this.exchangeService.placeOrder('Buy', this.positionSize);
      
      if (order) {
        this.logger.log(`Длинная позиция открыта: ${JSON.stringify(order)}`);
        
        if (price) {
          const priceNum = parseFloat(price);
          const stopLossPrice = (priceNum * (1 - this.stopLossPercent / 100)).toFixed(2);
          const takeProfitPrice = (priceNum * (1 + this.takeProfitPercent / 100)).toFixed(2);
          
          const positions = await this.exchangeService.getPositions();
          const position = positions.find(pos => pos.side === 'Buy' && parseFloat(pos.size) > 0);
          if (position) {
            await this.exchangeService.setTradingStop(position.positionIdx, stopLossPrice, takeProfitPrice);
            this.logger.log(`Установлен стоп-лосс: ${stopLossPrice}, тейк-профит: ${takeProfitPrice}`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Ошибка при открытии длинной позиции: ${error.message}`);
    }
  }

  private async openShortPosition(price: string) {
    try {
      this.logger.log(`Открываем короткую позицию по ${this.symbol} с размером ${this.positionSize}`);
      
      const order = await this.exchangeService.placeOrder('Sell', this.positionSize);
      
      if (order) {
        this.logger.log(`Короткая позиция открыта: ${JSON.stringify(order)}`);
        
        if (price) {
          const priceNum = parseFloat(price);
          const stopLossPrice = (priceNum * (1 + this.stopLossPercent / 100)).toFixed(2);
          const takeProfitPrice = (priceNum * (1 - this.takeProfitPercent / 100)).toFixed(2);
          
          const positions = await this.exchangeService.getPositions();
          const position = positions.find(pos => pos.side === 'Sell' && parseFloat(pos.size) > 0);
          if (position) {
            await this.exchangeService.setTradingStop(position.positionIdx, stopLossPrice, takeProfitPrice);
            this.logger.log(`Установлен стоп-лосс: ${stopLossPrice}, тейк-профит: ${takeProfitPrice}`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Ошибка при открытии короткой позиции: ${error.message}`);
    }
  }

  private async updatePositionProtection() {
    try {
      const positions = await this.exchangeService.getPositions();
      
      for (const position of positions) {
        if (parseFloat(position.size) === 0) continue;
        
        const tradeSide = position.side as 'Buy' | 'Sell';
        
        const entryPrice = parseFloat(position.avgPrice || position.avgPrice || position.markPrice || '0');
        
        if (!entryPrice) {
          this.logger.warn(`Не удалось получить цену входа для позиции, пропускаем`);
          continue;
        }
        
        const hasStopLoss = position.stopLoss && parseFloat(position.stopLoss) > 0;
        const hasTakeProfit = position.takeProfit && parseFloat(position.takeProfit) > 0;
        
        if (!hasStopLoss || !hasTakeProfit) {
          const stopLossPrice = tradeSide === 'Buy'
            ? (entryPrice * (1 - this.stopLossPercent / 100)).toFixed(2)
            : (entryPrice * (1 + this.stopLossPercent / 100)).toFixed(2);
          const takeProfitPrice = tradeSide === 'Buy'
            ? (entryPrice * (1 + this.takeProfitPercent / 100)).toFixed(2)
            : (entryPrice * (1 - this.takeProfitPercent / 100)).toFixed(2);
          
          await this.exchangeService.setTradingStop(position.positionIdx, stopLossPrice, takeProfitPrice);
          this.logger.log(`Обновлены стоп-лосс: ${stopLossPrice}, тейк-профит: ${takeProfitPrice}`);
        }
      }
    } catch (error) {
      this.logger.error(`Ошибка при обновлении защиты позиций: ${error.message}`);
    }
  }

  stopTrading() {
    this.isTrading = false;
    this.logger.log('Торговля остановлена');
  }

  startTrading() {
    this.isTrading = true;
    this.logger.log('Торговля запущена');
  }

  async closeAllPositions() {
    try {
      const positions = await this.exchangeService.getPositions();
      
      for (const position of positions) {
        if (parseFloat(position.size) > 0) {
          // Конвертируем positionIdx в строку для метода closePosition
          await this.exchangeService.closePosition(
            String(position.positionIdx), 
            position.side as 'Buy' | 'Sell', 
            position.size
          );
          this.logger.log(`Позиция ${position.side} по ${this.symbol} закрыта`);
        }
      }
      
      this.logger.log('Все позиции закрыты');
    } catch (error) {
      this.logger.error(`Ошибка при закрытии всех позиций: ${error.message}`);
    }
  }
}