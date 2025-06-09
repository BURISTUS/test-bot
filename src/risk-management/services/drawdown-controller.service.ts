import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RiskMetrics } from '../interfaces/risk-management.interface'; // ИСПРАВЛЕН ИМПОРТ

@Injectable()
export class DrawdownControllerService {
  private readonly logger = new Logger(DrawdownControllerService.name);
  private peakValue: number = 0;
  private dailyStartBalance: number = 0;
  private weeklyStartBalance: number = 0;
  private monthlyStartBalance: number = 0;

  constructor(private configService: ConfigService) {
    // Инициализируем пиковое значение при старте
    this.initializeBaselines();
  }

  private async initializeBaselines() {
    // Здесь можно загрузить исторические значения из БД
    // Пока используем заглушки
    this.peakValue = 500; // Начальный капитал
    this.dailyStartBalance = 500;
    this.weeklyStartBalance = 500;
    this.monthlyStartBalance = 500;
  }

  /**
   * Обновляет метрики просадки
   */
  updateDrawdownMetrics(currentBalance: number): RiskMetrics {
    // Обновляем пиковое значение
    if (currentBalance > this.peakValue) {
      this.peakValue = currentBalance;
    }

    // Рассчитываем текущую просадку
    const currentDrawdown = ((this.peakValue - currentBalance) / this.peakValue) * 100;
    
    // Рассчитываем периодические P&L
    const dailyPnL = ((currentBalance - this.dailyStartBalance) / this.dailyStartBalance) * 100;
    const weeklyPnL = ((currentBalance - this.weeklyStartBalance) / this.weeklyStartBalance) * 100;
    const monthlyPnL = ((currentBalance - this.monthlyStartBalance) / this.monthlyStartBalance) * 100;

    // Рассчитываем общий риск-скор (0-100)
    const riskScore = this.calculateRiskScore(currentDrawdown, dailyPnL, weeklyPnL);

    return {
      currentDrawdown,
      maxDrawdownAllowed: 15, // 15% максимальная просадка
      dailyPnL,
      weeklyPnL,
      monthlyPnL,
      accountValue: currentBalance,
      riskScore,
      volatilityFactor: 1.0 // Будет рассчитываться в VolatilityAdjusterService
    };
  }

  /**
   * Рассчитывает общий риск-скор портфеля
   */
  private calculateRiskScore(
    drawdown: number,
    dailyPnL: number,
    weeklyPnL: number
  ): number {
    let riskScore = 0;

    // Компонент просадки (0-50 баллов)
    riskScore += Math.min(50, (drawdown / 15) * 50);

    // Компонент дневных потерь (0-25 баллов)
    if (dailyPnL < -2) {
      riskScore += Math.min(25, (Math.abs(dailyPnL) / 5) * 25);
    }

    // Компонент недельных потерь (0-25 баллов)
    if (weeklyPnL < -5) {
      riskScore += Math.min(25, (Math.abs(weeklyPnL) / 10) * 25);
    }

    return Math.min(100, riskScore);
  }

  /**
   * Сбрасывает дневные метрики (вызывается каждый день)
   */
  resetDailyMetrics(currentBalance: number) {
    this.dailyStartBalance = currentBalance;
    this.logger.log(`Сброшены дневные метрики. Стартовый баланс: ${currentBalance}`);
  }

  /**
   * Сбрасывает недельные метрики (вызывается каждую неделю)
   */
  resetWeeklyMetrics(currentBalance: number) {
    this.weeklyStartBalance = currentBalance;
    this.logger.log(`Сброшены недельные метрики. Стартовый баланс: ${currentBalance}`);
  }

  /**
   * Сбрасывает месячные метрики (вызывается каждый месяц)
   */
  resetMonthlyMetrics(currentBalance: number) {
    this.monthlyStartBalance = currentBalance;
    this.logger.log(`Сброшены месячные метрики. Стартовый баланс: ${currentBalance}`);
  }
}