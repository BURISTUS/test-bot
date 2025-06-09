import { Module } from '@nestjs/common';
import { RiskManagementService } from './risk-management.service';
import { RiskManagementController } from './risk-management.controller';
import { PositionSizingService } from './services/position-sizing.service';
import { DrawdownControllerService } from './services/drawdown-controller.service';
import { VolatilityAdjusterService } from './services/volatility-adjuster.service';
import { ExchangeModule } from '../exchange/exchange.module';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [ExchangeModule],
  providers: [
    RiskManagementService,
    PositionSizingService,
    DrawdownControllerService,
    VolatilityAdjusterService,
  ],
  controllers: [RiskManagementController],
  exports: [
    RiskManagementService,
    PositionSizingService,
    DrawdownControllerService,
    VolatilityAdjusterService,
  ],
})
export class RiskManagementModule {}