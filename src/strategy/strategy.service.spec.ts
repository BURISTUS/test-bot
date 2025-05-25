import { Test, TestingModule } from '@nestjs/testing';
import { TrendRsiStrategy } from './trend-rsi.strategy';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '../exchange/exchange.service';
import * as techIndicators from 'technicalindicators';

describe('TrendRsiStrategy', () => {
  let strategy: TrendRsiStrategy;
  let configService: ConfigService;
  let exchangeService: ExchangeService;

  // Мок данных свечей для тестирования
  const mockKlines = [
    // Свечи от новых к старым (как возвращает Binance API)
    // Формат: [timestamp, open, high, low, close, volume, ...]
    ['1620000000000', '50000', '51000', '49000', '50500', '100'],
    ['1619999900000', '49500', '50500', '49000', '50000', '100'],
    ['1619999800000', '49000', '49500', '48500', '49500', '100'],
    // ... добавьте больше свечей для полноценного теста
  ];

  // Подготовка моков для индикаторов
  const mockRsiValues = [30, 35, 40]; // Пример значений RSI
  const mockEmaShortValues = [49000, 49500, 50000]; // Пример значений короткой EMA
  const mockEmaLongValues = [48500, 49000, 49500]; // Пример значений длинной EMA

  beforeEach(async () => {
    // Создаем мок для ConfigService
    const configServiceMock = {
      get: jest.fn((key) => {
        const configs = {
          'SYMBOL': 'BTCUSDT',
          'TIMEFRAME': '15m',
          'RSI_PERIOD': '14',
          'RSI_OVERBOUGHT': '70',
          'RSI_OVERSOLD': '30',
          'EMA_SHORT_PERIOD': '9',
          'EMA_LONG_PERIOD': '21',
        };
        return configs[key];
      }),
    };

    // Создаем мок для ExchangeService
    const exchangeServiceMock = {
      getKlines: jest.fn().mockResolvedValue(mockKlines),
    };

    // Мокаем функции расчета индикаторов
    jest.spyOn(techIndicators.RSI, 'calculate').mockReturnValue(mockRsiValues);
    jest.spyOn(techIndicators.EMA, 'calculate')
      .mockImplementation((input) => {
        if (input.period === 9) return mockEmaShortValues;
        if (input.period === 21) return mockEmaLongValues;
        return [];
      });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrendRsiStrategy,
        { provide: ConfigService, useValue: configServiceMock },
        { provide: ExchangeService, useValue: exchangeServiceMock },
      ],
    }).compile();

    strategy = module.get<TrendRsiStrategy>(TrendRsiStrategy);
    configService = module.get<ConfigService>(ConfigService);
    exchangeService = module.get<ExchangeService>(ExchangeService);
  });

  it('should be defined', () => {
    expect(strategy).toBeDefined();
  });

  it('should fetch klines data from exchange service', async () => {
    await strategy.analyze();
    expect(exchangeService.getKlines).toHaveBeenCalledWith('15m', 200);
  });

  it('should return HOLD signal when no data available', async () => {
    jest.spyOn(exchangeService, 'getKlines').mockResolvedValueOnce([]);
    const result = await strategy.analyze();
    expect(result.action).toBe('HOLD');
    expect(result.reason).toBe('Недостаточно данных для анализа');
  });

  it('should generate BUY signal when EMA cross and RSI is oversold', async () => {
    // Переопределяем моки для конкретного теста
    jest.spyOn(techIndicators.RSI, 'calculate').mockReturnValue([25, 28]); // RSI в зоне перепроданности
    jest.spyOn(techIndicators.EMA, 'calculate')
      .mockImplementation((input) => {
        if (input.period === 9) return [49000, 50000]; // Короткая EMA пересекает длинную снизу вверх
        if (input.period === 21) return [49500, 49800]; 
        return [];
      });

    const result = await strategy.analyze();
    expect(result.action).toBe('BUY');
    expect(result.reason).toContain('Сигнал на покупку');
  });

  it('should generate SELL signal when EMA cross and RSI is overbought', async () => {
    // Переопределяем моки для конкретного теста
    jest.spyOn(techIndicators.RSI, 'calculate').mockReturnValue([75, 78]); // RSI в зоне перекупленности
    jest.spyOn(techIndicators.EMA, 'calculate')
      .mockImplementation((input) => {
        if (input.period === 9) return [50000, 49800]; // Короткая EMA пересекает длинную сверху вниз
        if (input.period === 21) return [49500, 50000]; 
        return [];
      });

    const result = await strategy.analyze();
    expect(result.action).toBe('SELL');
    expect(result.reason).toContain('Сигнал на продажу');
  });

  it('should generate HOLD signal when no clear signal', async () => {
    // Настраиваем моки так, чтобы не было сигнала
    jest.spyOn(techIndicators.RSI, 'calculate').mockReturnValue([50, 55]); // RSI в нейтральной зоне
    jest.spyOn(techIndicators.EMA, 'calculate')
      .mockImplementation((input) => {
        if (input.period === 9) return [49500, 49600]; // Нет пересечения
        if (input.period === 21) return [49000, 49100]; 
        return [];
      });

    const result = await strategy.analyze();
    expect(result.action).toBe('HOLD');
    expect(result.reason).toBe('Нет четкого сигнала');
  });
});