import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PositionSizingParams } from '../interfaces/risk-management.interface';

@Injectable()
export class PositionSizingService {
  private readonly logger = new Logger(PositionSizingService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Рассчитывает оптимальный размер позиции на основе волатильности и риска
   * Использует метод Kelly Criterion с ограничениями
   */
  calculatePositionSize(params: PositionSizingParams): number {
    const {
      accountBalance,
      volatility,
      stopLossPercent,
      riskPerTradePercent,
      maxPositionPercent
    } = params;

    // Базовый размер позиции (% от капитала под риском)
    const riskAmount = accountBalance * (riskPerTradePercent / 100);
    
    // Размер позиции основанный на стоп-лоссе
    const basePositionSize = riskAmount / (stopLossPercent / 100);
    
    // Корректировка на волатильность (высокая волатильность = меньше размер)
    const volatilityAdjustment = Math.max(0.1, 1 - (volatility - 1) * 0.5);
    
    // Финальный размер позиции
    let finalPositionSize = basePositionSize * volatilityAdjustment;
    
    // Применяем максимальные лимиты
    const maxPositionValue = accountBalance * (maxPositionPercent / 100);
    finalPositionSize = Math.min(finalPositionSize, maxPositionValue);
    
    this.logger.debug(
      `Position sizing: Base=${basePositionSize.toFixed(2)}, ` +
      `Volatility adj=${volatilityAdjustment.toFixed(2)}, ` +
      `Final=${finalPositionSize.toFixed(2)}`
    );
    
    return finalPositionSize;
  }

  /**
   * Рассчитывает оптимальные уровни стоп-лосса на основе волатильности
   */
  calculateDynamicStopLoss(
    entryPrice: number,
    side: 'BUY' | 'SELL',
    volatility: number,
    baseStopLossPercent: number
  ): number {
    // Увеличиваем стоп-лосс при высокой волатильности
    const volatilityMultiplier = Math.max(0.5, Math.min(2.0, volatility));
    const adjustedStopLoss = baseStopLossPercent * volatilityMultiplier;
    
    if (side === 'BUY') {
      return entryPrice * (1 - adjustedStopLoss / 100);
    } else {
      return entryPrice * (1 + adjustedStopLoss / 100);
    }
  }
}