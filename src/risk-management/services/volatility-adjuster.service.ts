import { Injectable, Logger } from '@nestjs/common';
import * as techIndicators from 'technicalindicators';

@Injectable()
export class VolatilityAdjusterService {
  private readonly logger = new Logger(VolatilityAdjusterService.name);
  private volatilityHistory: number[] = [];

  /**
   * Рассчитывает текущую волатильность рынка
   */
  calculateVolatility(prices: number[], period: number = 14): number {
    if (prices.length < period) {
      return 1.0; // Нейтральная волатильность по умолчанию
    }

    // Используем ATR (Average True Range) для расчета волатильности
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      const dailyReturn = (prices[i] - prices[i - 1]) / prices[i - 1];
      returns.push(Math.abs(dailyReturn));
    }

    // Стандартное отклонение доходностей
    const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance) * Math.sqrt(252); // Аннуализированная волатильность

    // Нормализуем относительно исторической волатильности
    this.volatilityHistory.push(volatility);
    if (this.volatilityHistory.length > 100) {
      this.volatilityHistory.shift();
    }

    const avgHistoricalVol = this.volatilityHistory.reduce((sum, vol) => sum + vol, 0) / this.volatilityHistory.length;
    const normalizedVolatility = volatility / avgHistoricalVol;

    this.logger.debug(
      `Volatility: Current=${volatility.toFixed(4)}, ` +
      `Historical Avg=${avgHistoricalVol.toFixed(4)}, ` +
      `Normalized=${normalizedVolatility.toFixed(2)}`
    );

    return normalizedVolatility;
  }

  /**
   * Рассчитывает фактор корректировки торговых параметров на основе волатильности
   */
  getVolatilityAdjustments(volatility: number): {
    positionSizeMultiplier: number;
    stopLossMultiplier: number;
    takeProfitMultiplier: number;
  } {
    // При высокой волатильности уменьшаем размер позиций и увеличиваем стопы
    const positionSizeMultiplier = Math.max(0.2, Math.min(1.5, 1 / volatility));
    const stopLossMultiplier = Math.max(0.5, Math.min(2.5, volatility));
    const takeProfitMultiplier = Math.max(0.8, Math.min(2.0, volatility * 0.8));

    return {
      positionSizeMultiplier,
      stopLossMultiplier,
      takeProfitMultiplier
    };
  }
}
