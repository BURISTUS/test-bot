import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RiskManagementService } from './risk-management.service';
import { PositionSizingService } from './services/position-sizing.service';
import { DrawdownControllerService } from './services/drawdown-controller.service';
import { VolatilityAdjusterService } from './services/volatility-adjuster.service';
import { ExchangeService } from '../exchange/exchange.service';

describe('RiskManagementService', () => {
  let service: RiskManagementService;
  let exchangeService: ExchangeService;
  let drawdownController: DrawdownControllerService;
  let positionSizing: PositionSizingService;

  const mockConfig = {
    get: jest.fn((key: string) => {
      const configs = {
        'MAX_DRAWDOWN_PERCENT': '15',
        'MAX_DAILY_LOSS_PERCENT': '3',
        'MAX_WEEKLY_LOSS_PERCENT': '8',
        'MAX_POSITION_SIZE_PERCENT': '10',
        'MAX_OPEN_POSITIONS': '3',
        'MAX_RISK_SCORE': '75',
      };
      return configs[key];
    }),
  };

  const mockExchange = {
    getAccountBalance: jest.fn(),
    getPositions: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiskManagementService,
        PositionSizingService,
        DrawdownControllerService,
        VolatilityAdjusterService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: ExchangeService, useValue: mockExchange },
      ],
    }).compile();

    service = module.get<RiskManagementService>(RiskManagementService);
    exchangeService = module.get<ExchangeService>(ExchangeService);
    drawdownController = module.get<DrawdownControllerService>(DrawdownControllerService);
    positionSizing = module.get<PositionSizingService>(PositionSizingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('evaluateTradeRisk', () => {
    beforeEach(() => {
      // Мокаем успешный баланс
      mockExchange.getAccountBalance.mockResolvedValue({
        list: [{ totalWalletBalance: '1000' }]
      });
      
      // Мокаем отсутствие открытых позиций по умолчанию
      mockExchange.getPositions.mockResolvedValue([]);
    });

    it('should allow trade when all conditions are met', async () => {
      // Мокаем нормальные метрики риска
      jest.spyOn(drawdownController, 'updateDrawdownMetrics').mockReturnValue({
        currentDrawdown: 5,
        maxDrawdownAllowed: 15,
        dailyPnL: 1,
        weeklyPnL: 2,
        monthlyPnL: 5,
        accountValue: 1000,
        riskScore: 30,
        volatilityFactor: 1.0,
      });

      const result = await service.evaluateTradeRisk(50000, 'BUY', 1.2);

      expect(result.canTrade).toBe(true);
      expect(result.riskLevel).toBe('LOW');
      expect(result.recommendedPositionSize).toBeGreaterThan(0);
    });

    it('should reject trade when daily loss limit exceeded', async () => {
      jest.spyOn(drawdownController, 'updateDrawdownMetrics').mockReturnValue({
        currentDrawdown: 5,
        maxDrawdownAllowed: 15,
        dailyPnL: -4, // Превышает лимит -3%
        weeklyPnL: -4,
        monthlyPnL: -4,
        accountValue: 960,
        riskScore: 50,
        volatilityFactor: 1.0,
      });

      const result = await service.evaluateTradeRisk(50000, 'BUY', 1.0);

      expect(result.canTrade).toBe(false);
      expect(result.reason).toContain('дневных потерь');
    });

    it('should reject trade when too many positions open', async () => {
      // Мокаем максимальное количество позиций
      mockExchange.getPositions.mockResolvedValue([
        { size: '0.1' },
        { size: '0.2' },
        { size: '0.15' },
      ]);

      jest.spyOn(drawdownController, 'updateDrawdownMetrics').mockReturnValue({
        currentDrawdown: 2,
        maxDrawdownAllowed: 15,
        dailyPnL: 0.5,
        weeklyPnL: 1,
        monthlyPnL: 3,
        accountValue: 1020,
        riskScore: 20,
        volatilityFactor: 1.0,
      });

      const result = await service.evaluateTradeRisk(50000, 'BUY', 1.0);

      expect(result.canTrade).toBe(false);
      expect(result.reason).toContain('максимальное количество позиций');
    });

    it('should reject trade when drawdown limit exceeded', async () => {
      // Мокаем высокую просадку
      jest.spyOn(drawdownController, 'updateDrawdownMetrics').mockReturnValue({
        currentDrawdown: 20, // Превышает лимит 15%
        maxDrawdownAllowed: 15,
        dailyPnL: -5,
        weeklyPnL: -10,
        monthlyPnL: -15,
        accountValue: 800,
        riskScore: 85,
        volatilityFactor: 1.5,
      });

      const result = await service.evaluateTradeRisk(50000, 'BUY', 1.2);

      expect(result.canTrade).toBe(false);
      expect(result.reason).toContain('просадка');
    });
  });

  describe('position sizing', () => {
    it('should calculate smaller position size for high volatility', () => {
      const lowVolParams = {
        accountBalance: 1000,
        volatility: 0.8, // Низкая волатильность
        stopLossPercent: 1.5,
        riskPerTradePercent: 1.0,
        maxPositionPercent: 10,
      };

      const highVolParams = {
        ...lowVolParams,
        volatility: 2.0, // Высокая волатильность
      };

      const lowVolSize = positionSizing.calculatePositionSize(lowVolParams);
      const highVolSize = positionSizing.calculatePositionSize(highVolParams);

      expect(highVolSize).toBeLessThan(lowVolSize);
    });

    it('should respect maximum position size limit', () => {
      const params = {
        accountBalance: 1000,
        volatility: 0.5, // Очень низкая волатильность
        stopLossPercent: 0.1, // Очень маленький стоп-лосс
        riskPerTradePercent: 5.0, // Высокий риск
        maxPositionPercent: 10, // Максимум 10%
      };

      const positionSize = positionSizing.calculatePositionSize(params);
      const maxAllowed = params.accountBalance * (params.maxPositionPercent / 100);

      expect(positionSize).toBeLessThanOrEqual(maxAllowed);
    });

    it('should calculate dynamic stop loss based on volatility', () => {
      const entryPrice = 50000;
      const baseStopLoss = 1.0; // 1%

      const lowVolStopLoss = positionSizing.calculateDynamicStopLoss(
        entryPrice, 'BUY', 0.5, baseStopLoss
      );
      
      const highVolStopLoss = positionSizing.calculateDynamicStopLoss(
        entryPrice, 'BUY', 2.0, baseStopLoss
      );

      // При высокой волатильности стоп-лосс должен быть дальше от цены входа
      expect(highVolStopLoss).toBeLessThan(lowVolStopLoss);
      expect(lowVolStopLoss).toBeLessThan(entryPrice);
    });
  });

  describe('volatility adjustment', () => {
    it('should provide smaller position multiplier for high volatility', () => {
      const volatilityAdjuster = new VolatilityAdjusterService();

      const lowVolAdjustments = volatilityAdjuster.getVolatilityAdjustments(0.8);
      const highVolAdjustments = volatilityAdjuster.getVolatilityAdjustments(2.0);

      expect(highVolAdjustments.positionSizeMultiplier)
        .toBeLessThan(lowVolAdjustments.positionSizeMultiplier);
      
      expect(highVolAdjustments.stopLossMultiplier)
        .toBeGreaterThan(lowVolAdjustments.stopLossMultiplier);
    });
  });

  describe('drawdown calculation', () => {
    it('should calculate risk score correctly', async () => {
      const drawdownController = new DrawdownControllerService(mockConfig as any);
      
      // Simulate losses
      const metrics = drawdownController.updateDrawdownMetrics(900); // 10% loss from 1000
      
      expect(metrics.currentDrawdown).toBeGreaterThan(0);
      expect(metrics.dailyPnL).toBeLessThan(0);
      expect(metrics.riskScore).toBeGreaterThan(0);
    });

    it('should increase risk score with higher losses', async () => {
      const drawdownController = new DrawdownControllerService(mockConfig as any);
      
      const smallLossMetrics = drawdownController.updateDrawdownMetrics(950);
      const largeLossMetrics = drawdownController.updateDrawdownMetrics(800);
      
      expect(largeLossMetrics.riskScore).toBeGreaterThan(smallLossMetrics.riskScore);
    });
  });
});


describe('Risk Decision Logic', () => {
  let service: RiskManagementService;
  let mockExchange: any;
  let mockDrawdownController: any;

  beforeEach(async () => {
    mockExchange = {
      getAccountBalance: jest.fn().mockResolvedValue({
        list: [{ totalWalletBalance: '1000' }]
      }),
      getPositions: jest.fn().mockResolvedValue([]),
    };

    mockDrawdownController = {
      updateDrawdownMetrics: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        RiskManagementService,
        PositionSizingService,
        { provide: DrawdownControllerService, useValue: mockDrawdownController },
        VolatilityAdjusterService,
        { provide: ExchangeService, useValue: mockExchange },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const configs = {
                'MAX_DRAWDOWN_PERCENT': '15',
                'MAX_DAILY_LOSS_PERCENT': '3',
                'MAX_WEEKLY_LOSS_PERCENT': '8',
                'MAX_POSITION_SIZE_PERCENT': '10',
                'MAX_OPEN_POSITIONS': '3',
                'MAX_RISK_SCORE': '75',
              };
              return configs[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<RiskManagementService>(RiskManagementService);
  });

  describe('Daily Loss Limit Logic', () => {
    it('should reject when daily PnL exceeds -3%', async () => {
      mockDrawdownController.updateDrawdownMetrics.mockReturnValue({
        currentDrawdown: 2,
        maxDrawdownAllowed: 15,
        dailyPnL: -3.5, // Exceeds -3% limit
        weeklyPnL: -2,
        monthlyPnL: 1,
        accountValue: 1000,
        riskScore: 40,
        volatilityFactor: 1.0,
      });

      const result = await service.evaluateTradeRisk(50000, 'BUY', 1.0);

      expect(result.canTrade).toBe(false);
      expect(result.reason).toMatch(/дневных потерь/i);
      expect(result.riskLevel).toBe('CRITICAL');
    });

    it('should allow when daily PnL is within limit', async () => {
      mockDrawdownController.updateDrawdownMetrics.mockReturnValue({
        currentDrawdown: 2,
        maxDrawdownAllowed: 15,
        dailyPnL: -2.5, // Within -3% limit
        weeklyPnL: -2,
        monthlyPnL: 1,
        accountValue: 1000,
        riskScore: 30,
        volatilityFactor: 1.0,
      });

      const result = await service.evaluateTradeRisk(50000, 'BUY', 1.0);

      expect(result.canTrade).toBe(true);
    });
  });

  describe('Position Count Logic', () => {
    it('should reject when max positions exceeded', async () => {
      // Mock 3 open positions (matches MAX_OPEN_POSITIONS limit)
      mockExchange.getPositions.mockResolvedValue([
        { size: '0.1' },
        { size: '0.2' },
        { size: '0.15' },
      ]);

      mockDrawdownController.updateDrawdownMetrics.mockReturnValue({
        currentDrawdown: 1,
        maxDrawdownAllowed: 15,
        dailyPnL: 0.5,
        weeklyPnL: 1,
        monthlyPnL: 3,
        accountValue: 1000,
        riskScore: 20,
        volatilityFactor: 1.0,
      });

      const result = await service.evaluateTradeRisk(50000, 'BUY', 1.0);

      expect(result.canTrade).toBe(false);
      expect(result.reason).toMatch(/максимальное количество позиций/i);
    });

    it('should allow when positions under limit', async () => {
      // Mock 2 open positions (under limit of 3)
      mockExchange.getPositions.mockResolvedValue([
        { size: '0.1' },
        { size: '0.2' },
      ]);

      mockDrawdownController.updateDrawdownMetrics.mockReturnValue({
        currentDrawdown: 1,
        maxDrawdownAllowed: 15,
        dailyPnL: 0.5,
        weeklyPnL: 1,
        monthlyPnL: 3,
        accountValue: 1000,
        riskScore: 20,
        volatilityFactor: 1.0,
      });

      const result = await service.evaluateTradeRisk(50000, 'BUY', 1.0);

      expect(result.canTrade).toBe(true);
    });
  });
});