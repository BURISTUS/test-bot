import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ExchangeModule } from './exchange/exchange.module';
import { StrategyModule } from './strategy/strategy.module';
import { TradingModule } from './trading/trading.module';
import { BacktestModule } from './backtest/backtest.module';
import { RiskManagementModule } from './risk-management/risk-management.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    ExchangeModule,
    StrategyModule,
    TradingModule,
    BacktestModule,
    RiskManagementModule
  ],
})
export class AppModule {}