  export interface RiskDecision {
    canTrade: boolean;
    recommendedPositionSize: number;
    adjustedStopLoss: number;
    adjustedTakeProfit: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    reason: string;
    actions: string[];
  }