import { Module } from '@nestjs/common';
import { BacktestService } from './backtest.service';
import { BacktestController } from './backtest.controller';
import { ExchangeModule } from '../exchange/exchange.module';
import { StrategyModule } from '../strategy/strategy.module';

@Module({
  imports: [ExchangeModule, StrategyModule],
  providers: [BacktestService],
  controllers: [BacktestController],
  exports: [BacktestService],
})
export class BacktestModule {}
