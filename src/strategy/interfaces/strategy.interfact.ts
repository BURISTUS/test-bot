export interface TradeSignal {
    action: 'BUY' | 'SELL' | 'HOLD';
    price?: number;
    reason: string;
  }
  
  export interface StrategyInterface {
    analyze(): Promise<TradeSignal>;
  }