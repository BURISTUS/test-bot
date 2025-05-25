import { Module } from '@nestjs/common';
import { TradingService } from './trading.service';
import { ExchangeModule } from '../exchange/exchange.module';
import { StrategyModule } from '../strategy/strategy.module';

@Module({
  imports: [ExchangeModule, StrategyModule],
  providers: [TradingService],
})
export class TradingModule {}