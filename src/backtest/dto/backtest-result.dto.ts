export interface Trade {
    entryDate: string;
    entryPrice: number;
    exitDate: string;
    exitPrice: number;
    side: 'BUY' | 'SELL';
    profit: number;
    profitPercent: number;
    duration: number;
  }
  
  export interface BacktestResult {
    symbol: string;
    period: string;
    startDate: string;
    endDate: string;
    initialBalance: number;
    finalBalance: number;
    totalProfit: number;
    profitPercent: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    sharpeRatio: number;
    trades: Trade[];
    monthlyReturns: Record<string, number>;
    equityCurve: number[];
  }