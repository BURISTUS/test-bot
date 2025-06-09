export interface RiskMetrics {
    currentDrawdown: number;
    maxDrawdownAllowed: number;
    dailyPnL: number;
    weeklyPnL: number;
    monthlyPnL: number;
    accountValue: number;
    riskScore: number; // 0-100
    volatilityFactor: number;
  }
  
  export interface PositionSizingParams {
    accountBalance: number;
    volatility: number;
    stopLossPercent: number;
    riskPerTradePercent: number;
    maxPositionPercent: number;
  }
  
  export interface RiskLimits {
    maxDrawdownPercent: number;
    maxDailyLossPercent: number;
    maxWeeklyLossPercent: number;
    maxPositionSizePercent: number;
    maxOpenPositions: number;
    maxRiskScore: number;
  }
  
