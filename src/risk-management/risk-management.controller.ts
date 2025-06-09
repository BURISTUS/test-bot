import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { RiskManagementService } from './risk-management.service';
import { TradingService } from '../trading/trading.service';

@Controller('risk-management')
export class RiskManagementController {
  constructor(
    private riskManagementService: RiskManagementService,
    private tradingService: TradingService,
  ) {}

  /**
   * Получить текущие метрики риска
   */
  @Get('metrics')
  async getCurrentMetrics() {
    const metrics = await this.riskManagementService.getCurrentRiskMetrics();
    return {
      success: true,
      data: metrics,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Оценить риск для гипотетической сделки
   */
  @Post('evaluate')
  async evaluateRisk(@Body() params: {
    entryPrice: number;
    side: 'BUY' | 'SELL';
    volatility?: number;
  }) {
    const { entryPrice, side, volatility = 1.0 } = params;
    
    const riskDecision = await this.riskManagementService.evaluateTradeRisk(
      entryPrice,
      side,
      volatility
    );
    
    return {
      success: true,
      data: riskDecision,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Экстренная остановка торговли
   */
  @Post('emergency-stop')
  async emergencyStop() {
    await this.tradingService.emergencyCloseAll();
    
    return {
      success: true,
      message: 'Экстренная остановка активирована. Все позиции закрыты.',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Сброс аварийной остановки
   */
  @Post('reset-emergency')
  async resetEmergency() {
    this.riskManagementService.resetEmergencyStop();
    
    return {
      success: true,
      message: 'Аварийная остановка сброшена',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Запустить торговлю
   */
  @Post('start-trading')
  async startTrading() {
    this.tradingService.startTrading();
    
    return {
      success: true,
      message: 'Торговля запущена',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Остановить торговлю
   */
  @Post('stop-trading')
  async stopTrading() {
    this.tradingService.stopTrading();
    
    return {
      success: true,
      message: 'Торговля остановлена',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Получить дашборд с ключевыми метриками
   */
  @Get('dashboard')
  async getDashboard() {
    try {
      const metrics = await this.riskManagementService.getCurrentRiskMetrics();
      
      if (!metrics) {
        return {
          success: false,
          message: 'Не удалось получить метрики риска',
        };
      }

      // Рассчитываем дополнительные метрики для дашборда
      const riskStatus = this.getRiskStatus(metrics.riskScore);
      const drawdownStatus = this.getDrawdownStatus(metrics.currentDrawdown);
      
      return {
        success: true,
        data: {
          overview: {
            accountValue: metrics.accountValue,
            riskScore: metrics.riskScore,
            riskStatus,
            currentDrawdown: metrics.currentDrawdown,
            drawdownStatus,
          },
          performance: {
            dailyPnL: metrics.dailyPnL,
            weeklyPnL: metrics.weeklyPnL,
            monthlyPnL: metrics.monthlyPnL,
          },
          limits: {
            maxDrawdownAllowed: metrics.maxDrawdownAllowed,
            volatilityFactor: metrics.volatilityFactor,
          },
          alerts: this.generateAlerts(metrics),
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        message: `Ошибка получения дашборда: ${error.message}`,
      };
    }
  }

  private getRiskStatus(riskScore: number): string {
    if (riskScore < 25) return '🟢 НИЗКИЙ';
    if (riskScore < 50) return '🟡 СРЕДНИЙ';
    if (riskScore < 75) return '🟠 ВЫСОКИЙ';
    return '🔴 КРИТИЧЕСКИЙ';
  }

  private getDrawdownStatus(drawdown: number): string {
    if (drawdown < 3) return '🟢 ОТЛИЧНО';
    if (drawdown < 7) return '🟡 НОРМА';
    if (drawdown < 12) return '🟠 ВНИМАНИЕ';
    return '🔴 ОПАСНО';
  }

  private generateAlerts(metrics: any): string[] {
    const alerts = [];

    if (metrics.currentDrawdown > 10) {
      alerts.push(`⚠️ Просадка ${metrics.currentDrawdown.toFixed(2)}% близка к лимиту`);
    }

    if (metrics.dailyPnL < -2) {
      alerts.push(`📉 Дневные потери ${metrics.dailyPnL.toFixed(2)}% превышают норму`);
    }

    if (metrics.riskScore > 70) {
      alerts.push(`🎯 Высокий риск-скор ${metrics.riskScore.toFixed(1)}/100`);
    }

    if (metrics.weeklyPnL < -5) {
      alerts.push(`📊 Недельные потери ${metrics.weeklyPnL.toFixed(2)}% требуют внимания`);
    }

    if (alerts.length === 0) {
      alerts.push('✅ Все показатели в норме');
    }

    return alerts;
  }
}