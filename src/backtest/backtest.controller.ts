import { Controller, Get, Post, Body, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { BacktestService } from './backtest.service';
import { BacktestResult } from './dto/backtest-result.dto';
import { PairMetrics } from './dto/pair-metrics.dto';

@Controller('backtest')
export class BacktestController {
  constructor(private backtestService: BacktestService) {}

  @Get('pairs')
  async analyzePairs(
    @Query('timeframe') timeframe: string = '4h',
    @Query('days') days: number = 30,
  ) {
    // Список популярных пар для анализа
    const symbols = [
    //   'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT',
      'SOLUSDT'/*, 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT',*/
    //   'LINKUSDT', 'UNIUSDT', 'ATOMUSDT', 'ETCUSDT', 'LTCUSDT',
    ];
    
    return this.backtestService.analyzePairs(symbols, timeframe, days);
  }

  @Post('run')
  async runBacktest(@Body() params: any) {
    const {
      symbol,
      timeframe,
      startTime,
      endTime,
      initialBalance,
      positionSize,
      stopLoss,
      takeProfit,
    } = params;
    
    return this.backtestService.runBacktest(
      symbol,
      timeframe,
      new Date(startTime).getTime(),
      new Date(endTime).getTime(),
      initialBalance || 10000,
      positionSize || 5,
      stopLoss || 1,
      takeProfit || 2,
    );
  }

  @Post('optimize')
  async optimizeStrategy(@Body() params: any) {
    const {
      symbol,
      timeframe,
      startTime,
      endTime,
      initialBalance,
    } = params;
    
    return this.backtestService.optimizeStrategy(
      symbol,
      timeframe,
      new Date(startTime).getTime(),
      new Date(endTime).getTime(),
      initialBalance || 10000,
    );
  }

  @Post('validate')
  async validateRobustness(@Body() params: any) {
    const {
      symbol,
      timeframe,
      months,
      positionSize,
      stopLoss,
      takeProfit,
    } = params;
    
    return this.backtestService.validateStrategyRobustness(
      symbol,
      timeframe,
      months || 12,
      positionSize || 5,
      stopLoss || 1,
      takeProfit || 2,
    );
  }

  @Get('report')
  async getBacktestReport(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: string,
    @Query('startTime') startTime: string,
    @Query('endTime') endTime: string,
    @Res() res: Response,
  ) {
    const result = await this.backtestService.runBacktest(
      symbol,
      timeframe,
      new Date(startTime).getTime(),
      new Date(endTime).getTime(),
    );
    
    const report = this.backtestService.generateBacktestReport(result);
    
    res.setHeader('Content-Type', 'text/html');
    res.send(report);
  }
}