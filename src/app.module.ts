import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ExchangeModule } from './exchange/exchange.module';
import { StrategyModule } from './strategy/strategy.module';
import { TradingModule } from './trading/trading.module';
import { BacktestModule } from './backtest/backtest.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    ExchangeModule,
    StrategyModule,
    TradingModule,
    BacktestModule
  ],
})
export class AppModule {}