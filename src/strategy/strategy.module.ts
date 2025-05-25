import { Module } from '@nestjs/common';
import { TrendRsiStrategy } from './trend-rsi.strategy';
import { ExchangeModule } from '../exchange/exchange.module';
import { ExchangeService } from 'src/exchange/exchange.service';

@Module({
  imports: [ExchangeModule],
  providers: [TrendRsiStrategy],
  exports: [TrendRsiStrategy],
})
export class StrategyModule {}