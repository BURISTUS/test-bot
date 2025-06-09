// src/risk-management/risk-management.service.ts - ОСНОВНОЙ СЕРВИС
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PositionSizingService } from './services/position-sizing.service';
import { DrawdownControllerService } from './services/drawdown-controller.service';
import { VolatilityAdjusterService } from './services/volatility-adjuster.service';
import { ExchangeService } from '../exchange/exchange.service';
import { RiskLimits, PositionSizingParams } from './interfaces/risk-management.interface';
import { RiskDecision } from './dto/risk-decision.dto';

@Injectable()
export class RiskManagementService {
  private readonly logger = new Logger(RiskManagementService.name);
  private riskLimits: RiskLimits;
  private emergencyStopActive: boolean = false;

  constructor(
    private configService: ConfigService,
    private positionSizingService: PositionSizingService,
    private drawdownController: DrawdownControllerService,
    private volatilityAdjuster: VolatilityAdjusterService,
    private exchangeService: ExchangeService,
  ) {
    this.initializeRiskLimits();
  }

  private initializeRiskLimits() {
    this.riskLimits = {
      maxDrawdownPercent: parseFloat(this.configService.get('MAX_DRAWDOWN_PERCENT') || '15'),
      maxDailyLossPercent: parseFloat(this.configService.get('MAX_DAILY_LOSS_PERCENT') || '3'),
      maxWeeklyLossPercent: parseFloat(this.configService.get('MAX_WEEKLY_LOSS_PERCENT') || '8'),
      maxPositionSizePercent: parseFloat(this.configService.get('MAX_POSITION_SIZE_PERCENT') || '10'),
      maxOpenPositions: parseInt(this.configService.get('MAX_OPEN_POSITIONS') || '3'),
      maxRiskScore: parseFloat(this.configService.get('MAX_RISK_SCORE') || '75'),
    };

    this.logger.log(`Risk limits initialized: ${JSON.stringify(this.riskLimits)}`);
  }

  /**
   * Основная функция оценки риска перед входом в позицию
   */
  async evaluateTradeRisk(
    entryPrice: number,
    side: 'BUY' | 'SELL',
    marketVolatility: number
  ): Promise<RiskDecision> {
    try {
      // Получаем текущий баланс
      const balance = await this.getCurrentBalance();
      if (!balance) {
        return this.createRejectionDecision('Не удалось получить баланс аккаунта');
      }

      // Обновляем метрики просадки
      const riskMetrics = this.drawdownController.updateDrawdownMetrics(balance);

      // Проверяем критические лимиты
      if (this.emergencyStopActive) {
        return this.createRejectionDecision('Активирована аварийная остановка торговли');
      }

      if (riskMetrics.currentDrawdown > this.riskLimits.maxDrawdownPercent) {
        this.activateEmergencyStop('Превышена максимальная просадка');
        return this.createRejectionDecision('Превышена максимальная просадка');
      }

      // ИСПРАВЛЕНО: Проверка дневных потерь
      if (riskMetrics.dailyPnL < -this.riskLimits.maxDailyLossPercent) {
        return this.createRejectionDecision('Превышен лимит дневных потерь');
      }

      if (riskMetrics.weeklyPnL < -this.riskLimits.maxWeeklyLossPercent) {
        return this.createRejectionDecision('Превышен лимит недельных потерь');
      }

      if (riskMetrics.riskScore > this.riskLimits.maxRiskScore) {
        return this.createRejectionDecision('Высокий общий риск-скор портфеля');
      }

      // ИСПРАВЛЕНО: Проверяем количество открытых позиций
      const openPositions = await this.exchangeService.getPositions();
      const activePositions = openPositions.filter(pos => parseFloat(pos.size) > 0);
      
      if (activePositions.length >= this.riskLimits.maxOpenPositions) {
        return this.createRejectionDecision('Достигнуто максимальное количество позиций');
      }

      // Рассчитываем размер позиции
      const positionSizingParams: PositionSizingParams = {
        accountBalance: balance,
        volatility: marketVolatility,
        stopLossPercent: 1.5, // Базовый стоп-лосс
        riskPerTradePercent: 1.0, // 1% капитала под риском
        maxPositionPercent: this.riskLimits.maxPositionSizePercent,
      };

      const recommendedPositionSize = this.positionSizingService.calculatePositionSize(positionSizingParams);

      // Рассчитываем динамические уровни стоп-лосса и тейк-профита
      const adjustedStopLoss = this.positionSizingService.calculateDynamicStopLoss(
        entryPrice,
        side,
        marketVolatility,
        1.5
      );

      const adjustedTakeProfit = side === 'BUY' 
        ? entryPrice * (1 + (0.03 * marketVolatility)) // 3% * волатильность
        : entryPrice * (1 - (0.03 * marketVolatility));

      // Определяем уровень риска
      const riskLevel = this.determineRiskLevel(riskMetrics.riskScore, marketVolatility);

      return {
        canTrade: true,
        recommendedPositionSize,
        adjustedStopLoss,
        adjustedTakeProfit,
        riskLevel,
        reason: 'Все риск-проверки пройдены успешно',
        actions: [
          `Размер позиции: ${recommendedPositionSize.toFixed(4)}`,
          `Стоп-лосс: ${adjustedStopLoss.toFixed(2)}`,
          `Тейк-профит: ${adjustedTakeProfit.toFixed(2)}`,
          `Риск-скор: ${riskMetrics.riskScore.toFixed(1)}/100`
        ]
      };

    } catch (error) {
      this.logger.error(`Ошибка при оценке риска: ${error.message}`);
      return this.createRejectionDecision('Техническая ошибка при оценке риска');
    }
  }

  private createRejectionDecision(reason: string): RiskDecision {
    return {
      canTrade: false,
      recommendedPositionSize: 0,
      adjustedStopLoss: 0,
      adjustedTakeProfit: 0,
      riskLevel: 'CRITICAL',
      reason,
      actions: ['Торговля заблокирована']
    };
  }

  private determineRiskLevel(riskScore: number, volatility: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const combinedRisk = (riskScore / 100) * 0.7 + (volatility / 3) * 0.3;

    if (combinedRisk < 0.3) return 'LOW';
    if (combinedRisk < 0.6) return 'MEDIUM';
    if (combinedRisk < 0.8) return 'HIGH';
    return 'CRITICAL';
  }

  private async getCurrentBalance(): Promise<number | null> {
    try {
      const balanceData = await this.exchangeService.getAccountBalance();
      if (balanceData?.list?.[0]?.totalWalletBalance) {
        return parseFloat(balanceData.list[0].totalWalletBalance);
      }
      return null;
    } catch (error) {
      this.logger.error(`Ошибка получения баланса: ${error.message}`);
      return null;
    }
  }

  private activateEmergencyStop(reason: string) {
    this.emergencyStopActive = true;
    this.logger.error(`🚨 АВАРИЙНАЯ ОСТАНОВКА ТОРГОВЛИ: ${reason}`);
  }

  /**
   * Сброс аварийной остановки (только вручную)
   */
  resetEmergencyStop() {
    this.emergencyStopActive = false;
    this.logger.log('Аварийная остановка торговли сброшена');
  }

  /**
   * Ежедневный сброс метрик
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async resetDailyMetrics() {
    const balance = await this.getCurrentBalance();
    if (balance) {
      this.drawdownController.resetDailyMetrics(balance);
    }
  }

  /**
   * Еженедельный сброс метрик (каждый понедельник)
   */
  @Cron(CronExpression.EVERY_WEEK)
  async resetWeeklyMetrics() {
    const balance = await this.getCurrentBalance();
    if (balance) {
      this.drawdownController.resetWeeklyMetrics(balance);
    }
  }

  /**
   * Ежемесячный сброс метрик
   */
  @Cron('0 0 1 * *') // 1 число каждого месяца
  async resetMonthlyMetrics() {
    const balance = await this.getCurrentBalance();
    if (balance) {
      this.drawdownController.resetMonthlyMetrics(balance);
    }
  }

  /**
   * Получить текущие риск-метрики (для мониторинга)
   */ 
  async getCurrentRiskMetrics() {
    const balance = await this.getCurrentBalance();
    if (!balance) return null;

    return this.drawdownController.updateDrawdownMetrics(balance);
  }
}
