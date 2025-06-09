import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '../exchange/exchange.service';
import { TrendRsiStrategy } from '../strategy/trend-rsi.strategy';
import { RiskManagementService } from 'src/risk-management/risk-management.service';
import { VolatilityAdjusterService } from 'src/risk-management/services/volatility-adjuster.service';

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);
  private symbol: string;
  private isTrading: boolean = true;

  constructor(
    private configService: ConfigService,
    private exchangeService: ExchangeService,
    private trendRsiStrategy: TrendRsiStrategy,
    private riskManagementService: RiskManagementService,
    private volatilityAdjuster: VolatilityAdjusterService,
  ) {
    this.symbol = this.configService.get<string>('SYMBOL') || 'BTCUSDT';
    this.logger.log(`Торговый сервис с риск-менеджментом инициализирован для ${this.symbol}`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async executeTradingLogic() {
    if (!this.isTrading) {
      this.logger.debug('Торговля приостановлена');
      return;
    }
    
    try {
      // Получаем сигнал от стратегии
      const signal = await this.trendRsiStrategy.analyze();
      
      if (signal.action === 'HOLD') {
        this.logger.debug(`Сигнал: ${signal.action} - ${signal.reason}`);
        return;
      }

      // Рассчитываем волатильность рынка
      const klines = await this.exchangeService.getKlines('15m', 50);
      const closes = klines.map(candle => parseFloat(candle[4])).reverse();
      const marketVolatility = this.volatilityAdjuster.calculateVolatility(closes);

      // Проводим риск-анализ ПЕРЕД входом в позицию
      const riskDecision = await this.riskManagementService.evaluateTradeRisk(
        signal.price || parseFloat(klines[0][4]),
        signal.action,
        marketVolatility
      );

      this.logger.log(
        `Сигнал: ${signal.action} | Риск: ${riskDecision.riskLevel} | ` +
        `Можно торговать: ${riskDecision.canTrade} | ${riskDecision.reason}`
      );

      // Если риски не позволяют торговать
      if (!riskDecision.canTrade) {
        this.logger.warn(`❌ Сделка отклонена: ${riskDecision.reason}`);
        
        // Логируем действия для анализа
        riskDecision.actions.forEach(action => this.logger.warn(`   ${action}`));
        return;
      }

      // Выполняем сделку с параметрами от риск-менеджмента
      if (signal.action === 'BUY') {
        await this.openManagedPosition('Buy', riskDecision);
      } else if (signal.action === 'SELL') {
        await this.openManagedPosition('Sell', riskDecision);
      }

    } catch (error) {
      this.logger.error(`Ошибка в торговой логике: ${error.message}`);
    }
  }

  /**
   * Открывает позицию с управлением рисками
   */
  private async openManagedPosition(
    side: 'Buy' | 'Sell',
    riskDecision: any
  ) {
    try {
      const entryPrice = side === 'Buy' ? 'market' : 'market'; // Можно добавить лимитные ордера
      
      // Рассчитываем размер позиции в базовой валюте (например, BTC для BTCUSDT)
      const currentPrice = parseFloat((await this.exchangeService.getKlines('1m', 1))[0][4]);
      const positionSizeInQuote = riskDecision.recommendedPositionSize;
      const positionSizeInBase = (positionSizeInQuote / currentPrice).toFixed(6);

      this.logger.log(
        `🎯 Открываем ${side} позицию | ` +
        `Размер: ${positionSizeInBase} | ` +
        `Стоимость: $${positionSizeInQuote.toFixed(2)} | ` +
        `SL: ${riskDecision.adjustedStopLoss.toFixed(2)} | ` +
        `TP: ${riskDecision.adjustedTakeProfit.toFixed(2)}`
      );

      // Размещаем основной ордер
      const order = await this.exchangeService.placeOrder(side, positionSizeInBase);
      
      if (!order) {
        this.logger.error('Не удалось разместить основной ордер');
        return;
      }

      this.logger.log(`✅ Позиция открыта: ${JSON.stringify(order)}`);

      // Ждем немного и устанавливаем стоп-лосс и тейк-профит
      setTimeout(async () => {
        await this.setManagedStops(side, riskDecision);
      }, 2000);

    } catch (error) {
      this.logger.error(`Ошибка при открытии управляемой позиции: ${error.message}`);
    }
  }

  /**
   * Устанавливает стоп-лосс и тейк-профит на основе риск-анализа
   */
  private async setManagedStops(side: 'Buy' | 'Sell', riskDecision: any) {
    try {
      const positions = await this.exchangeService.getPositions();
      const position = positions.find(pos => 
        pos.side === side && parseFloat(pos.size) > 0
      );

      if (!position) {
        this.logger.warn('Позиция не найдена для установки стопов');
        return;
      }

      const success = await this.exchangeService.setTradingStop(
        position.positionIdx,
        riskDecision.adjustedStopLoss.toFixed(2),
        riskDecision.adjustedTakeProfit.toFixed(2)
      );

      if (success) {
        this.logger.log(
          `🛡️ Защита установлена | ` +
          `SL: ${riskDecision.adjustedStopLoss.toFixed(2)} | ` +
          `TP: ${riskDecision.adjustedTakeProfit.toFixed(2)}`
        );
      } else {
        this.logger.error('Не удалось установить стоп-лосс и тейк-профит');
      }

    } catch (error) {
      this.logger.error(`Ошибка при установке управляемых стопов: ${error.message}`);
    }
  }

  /**
   * Мониторинг позиций и обновление стопов
   */
  @Cron('*/5 * * * *') // Каждые 5 минут
  async monitorPositions() {
    try {
      const positions = await this.exchangeService.getPositions();
      const activePositions = positions.filter(pos => parseFloat(pos.size) > 0);

      if (activePositions.length === 0) return;

      // Получаем текущие риск-метрики
      const riskMetrics = await this.riskManagementService.getCurrentRiskMetrics();
      
      if (!riskMetrics) return;

      // Логируем текущее состояние рисков
      this.logger.debug(
        `📊 Риск-мониторинг | ` +
        `Просадка: ${riskMetrics.currentDrawdown.toFixed(2)}% | ` +
        `Дневной P&L: ${riskMetrics.dailyPnL.toFixed(2)}% | ` +
        `Риск-скор: ${riskMetrics.riskScore.toFixed(1)}/100`
      );

      // Если риск-скор высокий, можем ужесточить стопы
      if (riskMetrics.riskScore > 60) {
        await this.tightenStopLosses(activePositions, riskMetrics.riskScore);
      }

    } catch (error) {
      this.logger.error(`Ошибка при мониторинге позиций: ${error.message}`);
    }
  }

  /**
   * Ужесточает стоп-лоссы при высоком риске
   */
  private async tightenStopLosses(positions: any[], riskScore: number) {
    for (const position of positions) {
      try {
        const currentPrice = parseFloat((await this.exchangeService.getKlines('1m', 1))[0][4]);
        const entryPrice = parseFloat(position.avgPrice);
        
        // Рассчитываем текущую прибыль позиции
        const side = position.side as 'Buy' | 'Sell';
        const unrealizedPnL = side === 'Buy' 
          ? (currentPrice - entryPrice) / entryPrice
          : (entryPrice - currentPrice) / entryPrice;

        // Если позиция в прибыли и риск высокий, подтягиваем стоп к безубытку
        if (unrealizedPnL > 0.005 && riskScore > 70) { // 0.5% прибыль
          const breakEvenPrice = side === 'Buy' 
            ? entryPrice * 1.001 // Небольшой отступ для покрытия комиссий
            : entryPrice * 0.999;

          await this.exchangeService.setTradingStop(
            position.positionIdx,
            breakEvenPrice.toFixed(2),
            position.takeProfit || '0'
          );

          this.logger.log(
            `🔒 Стоп подтянут к безубытку | ` +
            `${side} | Цена: ${breakEvenPrice.toFixed(2)} | ` +
            `Риск-скор: ${riskScore.toFixed(1)}`
          );
        }

      } catch (error) {
        this.logger.error(`Ошибка при ужесточении стопов: ${error.message}`);
      }
    }
  }

  /**
   * Экстренное закрытие всех позиций
   */
  async emergencyCloseAll(): Promise<void> {
    try {
      this.logger.warn('🚨 ЭКСТРЕННОЕ ЗАКРЫТИЕ ВСЕХ ПОЗИЦИЙ');
      
      const positions = await this.exchangeService.getPositions();
      const activePositions = positions.filter(pos => parseFloat(pos.size) > 0);
      
      for (const position of activePositions) {
        await this.exchangeService.closePosition(
          String(position.positionIdx),
          position.side as 'Buy' | 'Sell',
          position.size
        );
        
        this.logger.warn(`❌ Закрыта ${position.side} позиция размером ${position.size}`);
      }
      
      // Останавливаем торговлю
      this.stopTrading();
      
    } catch (error) {
      this.logger.error(`Критическая ошибка при экстренном закрытии: ${error.message}`);
    }
  }

  stopTrading() {
    this.isTrading = false;
    this.logger.log('❌ Торговля остановлена');
  }

  startTrading() {
    this.isTrading = true;
    this.logger.log('✅ Торговля запущена');
  }

  async closeAllPositions() {
    return this.emergencyCloseAll();
  }
}
