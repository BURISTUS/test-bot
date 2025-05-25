import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '../exchange/exchange.service';
import { TrendRsiStrategy } from '../strategy/trend-rsi.strategy';
import * as fs from 'fs';
import * as path from 'path';
import * as Papa from 'papaparse';
import * as techIndicators from 'technicalindicators';
import { BacktestResult, Trade } from './dto/backtest-result.dto';
import { PairMetrics } from './dto/pair-metrics.dto';

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private readonly DATA_DIR = 'historical_data';

  constructor(
    private configService: ConfigService,
    private exchangeService: ExchangeService,
    private trendRsiStrategy: TrendRsiStrategy,
  ) {
    // Создаем директорию для хранения исторических данных, если она не существует
    if (!fs.existsSync(this.DATA_DIR)) {
      fs.mkdirSync(this.DATA_DIR, { recursive: true });
    }
  }

  /**
   * Загружает исторические данные для указанной пары и таймфрейма
   */
  async fetchHistoricalData(
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime: number,
  ): Promise<any[]> {
    try {
      this.logger.log(`Загрузка исторических данных для ${symbol} (${timeframe})`);
      
      // Создадим полный путь к файлу на основе параметров
      const fileName = `${symbol}_${timeframe}_${startTime}_${endTime}.csv`;
      const filePath = path.join(this.DATA_DIR, fileName);
      
      // Проверим, есть ли уже сохраненные данные
      if (fs.existsSync(filePath)) {
        this.logger.log(`Найдены локальные данные для ${symbol}, используем их`);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        return Papa.parse(fileContent, { header: true, dynamicTyping: true }).data;
      }
      
      // Данных нет, загружаем с биржи
      let allKlines = [];
      let currentStartTime = startTime;
      
      // Мы будем загружать данные порциями, так как API обычно ограничивает количество свечей за один запрос
      while (currentStartTime < endTime) {
        this.logger.debug(`Загрузка данных с ${new Date(currentStartTime).toISOString()}`);
        
        const klines = await this.exchangeService.getKlines(timeframe, 1000, currentStartTime);
        
        if (!klines || klines.length === 0) {
          break;
        }
        
        allKlines = [...allKlines, ...klines];
        
        // Обновляем время начала для следующего запроса
        const lastKlineTime = parseInt(klines[klines.length - 1][0]);
        currentStartTime = lastKlineTime + 1;
        
        // Небольшая задержка, чтобы не перегружать API
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      this.logger.log(`Загружено ${allKlines.length} свечей для ${symbol}`);
      
      // Преобразуем данные в формат, удобный для работы
      const formattedData = allKlines.map(candle => ({
        timestamp: parseInt(candle[0]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        date: new Date(parseInt(candle[0])).toISOString(),
      }));
      
      // Сохраняем данные для повторного использования
      fs.writeFileSync(filePath, Papa.unparse(formattedData));
      
      return formattedData;
    } catch (error) {
      this.logger.error(`Ошибка при загрузке исторических данных: ${error.message}`);
      return [];
    }
  }

  /**
   * Проводит полный бэктест стратегии на исторических данных
   */
  async runBacktest(
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime: number,
    initialBalance: number = 10000,
    positionSizePercent: number = 5,
    stopLossPercent: number = 1,
    takeProfitPercent: number = 2,
  ): Promise<BacktestResult> {
    try {
      this.logger.log(`Запуск бэктеста для ${symbol} (${timeframe})`);
      
      // Загружаем исторические данные
      const historicalData = await this.fetchHistoricalData(symbol, timeframe, startTime, endTime);
      
      if (historicalData.length === 0) {
        throw new Error('Недостаточно исторических данных для бэктеста');
      }
      
      // Инициализируем переменные для бэктеста
      let balance = initialBalance;
      let equity = initialBalance;
      let position = null;
      let trades: Trade[] = [];
      let equityCurve: number[] = [initialBalance];
      let monthlyReturns: Record<string, number> = {};
      let maxBalance = initialBalance;
      let maxDrawdown = 0;
      
      // Для метрик эффективности
      let lastMonthTimestamp = historicalData[0].timestamp;
      let lastMonthBalance = initialBalance;
      
      // Используем историческую копию параметров стратегии
      const rsiPeriod = 14;
      const rsiOverbought = 70;
      const rsiOversold = 30;
      const emaShortPeriod = 9;
      const emaLongPeriod = 21;
      
      // Рассчитываем индикаторы для всего диапазона данных
      const closes = historicalData.map(candle => candle.close);
      const rsiValues = this.calculateRSI(closes, rsiPeriod);
      const emaShort = this.calculateEMA(closes, emaShortPeriod);
      const emaLong = this.calculateEMA(closes, emaLongPeriod);
      
      // Отображаем прогресс
      let lastProgressPercent = 0;
      
      // Начинаем проход по историческим данным
      for (let i = Math.max(emaLongPeriod, rsiPeriod) + 1; i < historicalData.length; i++) {
        const candle = historicalData[i];
        const prevCandle = historicalData[i - 1];
        
        // Показываем прогресс каждые 10%
        const progressPercent = Math.floor((i / historicalData.length) * 100);
        if (progressPercent % 10 === 0 && progressPercent !== lastProgressPercent) {
          this.logger.log(`Прогресс бэктеста: ${progressPercent}%`);
          lastProgressPercent = progressPercent;
        }
        
        // Получаем значения индикаторов для текущей и предыдущей свечи
        const rsi = rsiValues[i - (rsiValues.length - closes.length)];
        const prevRsi = rsiValues[i - 1 - (rsiValues.length - closes.length)];
        const shortEma = emaShort[i - (emaShort.length - closes.length)];
        const longEma = emaLong[i - (emaLong.length - closes.length)];
        const prevShortEma = emaShort[i - 1 - (emaShort.length - closes.length)];
        const prevLongEma = emaLong[i - 1 - (emaLong.length - closes.length)];
        
        // Проверка на месячные метрики
        const candleMonth = new Date(candle.timestamp).toISOString().slice(0, 7); // YYYY-MM
        const prevCandleMonth = new Date(prevCandle.timestamp).toISOString().slice(0, 7);
        
        if (candleMonth !== prevCandleMonth) {
          // Смена месяца, записываем результат
          const monthlyReturn = ((balance - lastMonthBalance) / lastMonthBalance) * 100;
          monthlyReturns[prevCandleMonth] = monthlyReturn;
          
          lastMonthBalance = balance;
        }
        
        // Логика закрытия позиции по стоп-лоссу или тейк-профиту
        if (position) {
          let closePosition = false;
          let exitPrice = candle.close;
          let exitReason = '';
          
          // Проверка стоп-лосса
          if (position.side === 'BUY' && candle.low <= position.stopLoss) {
            exitPrice = position.stopLoss;
            exitReason = 'стоп-лосс';
            closePosition = true;
          } else if (position.side === 'SELL' && candle.high >= position.stopLoss) {
            exitPrice = position.stopLoss;
            exitReason = 'стоп-лосс';
            closePosition = true;
          }
          
          // Проверка тейк-профита
          if (!closePosition) {
            if (position.side === 'BUY' && candle.high >= position.takeProfit) {
              exitPrice = position.takeProfit;
              exitReason = 'тейк-профит';
              closePosition = true;
            } else if (position.side === 'SELL' && candle.low <= position.takeProfit) {
              exitPrice = position.takeProfit;
              exitReason = 'тейк-профит';
              closePosition = true;
            }
          }
          
          // Проверка сигнала на разворот
          if (!closePosition) {
            // Проверка разворота тренда для длинной позиции
            if (position.side === 'BUY' && prevShortEma > prevLongEma && shortEma < longEma && rsi > rsiOverbought) {
              exitReason = 'разворот тренда';
              closePosition = true;
            }
            // Проверка разворота тренда для короткой позиции
            else if (position.side === 'SELL' && prevShortEma < prevLongEma && shortEma > longEma && rsi < rsiOversold) {
              exitReason = 'разворот тренда';
              closePosition = true;
            }
          }
          
          // Закрываем позицию если есть сигнал
          if (closePosition) {
            const positionSize = position.size;
            let profit = 0;
            
            if (position.side === 'BUY') {
              profit = positionSize * (exitPrice - position.entryPrice);
            } else {
              profit = positionSize * (position.entryPrice - exitPrice);
            }
            
            balance += profit;
            equity = balance;
            
            const trade: Trade = {
              entryDate: position.entryDate,
              entryPrice: position.entryPrice,
              exitDate: candle.date,
              exitPrice: exitPrice,
              side: position.side,
              profit: profit,
              profitPercent: (profit / (positionSize * position.entryPrice)) * 100,
              duration: (candle.timestamp - position.timestamp) / (60 * 60 * 1000), // длительность в часах
            };
            
            trades.push(trade);
            
            this.logger.debug(
              `${candle.date}: Закрыта ${position.side} позиция по ${exitReason}. ` +
              `Вход: ${position.entryPrice}, Выход: ${exitPrice}, Прибыль: ${profit.toFixed(2)} (${trade.profitPercent.toFixed(2)}%)`,
            );
            
            position = null;
          }
        }
        
        // Обновляем максимальные значения для расчета просадки
        if (equity > maxBalance) {
          maxBalance = equity;
        }
        
        const currentDrawdown = maxBalance - equity;
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown;
        }
        
        // Добавляем текущий баланс в кривую капитала
        equityCurve.push(equity);
        
        // Если нет открытых позиций, проверяем сигналы на открытие
        if (!position) {
          // Сигнал на покупку (лонг)
          if (
            prevShortEma < prevLongEma && 
            shortEma > longEma && 
            rsi < rsiOversold
          ) {
            const positionSize = (balance * positionSizePercent / 100) / candle.close;
            const entryPrice = candle.close;
            const stopLoss = entryPrice * (1 - stopLossPercent / 100);
            const takeProfit = entryPrice * (1 + takeProfitPercent / 100);
            
            position = {
              side: 'BUY',
              entryPrice,
              stopLoss,
              takeProfit,
              size: positionSize,
              entryDate: candle.date,
              timestamp: candle.timestamp,
            };
            
            this.logger.debug(
              `${candle.date}: Открыта LONG позиция. Цена: ${entryPrice}, ` +
              `SL: ${stopLoss}, TP: ${takeProfit}, Размер: ${positionSize}`,
            );
          }
          // Сигнал на продажу (шорт)
          else if (
            prevShortEma > prevLongEma && 
            shortEma < longEma && 
            rsi > rsiOverbought
          ) {
            const positionSize = (balance * positionSizePercent / 100) / candle.close;
            const entryPrice = candle.close;
            const stopLoss = entryPrice * (1 + stopLossPercent / 100);
            const takeProfit = entryPrice * (1 - takeProfitPercent / 100);
            
            position = {
              side: 'SELL',
              entryPrice,
              stopLoss,
              takeProfit,
              size: positionSize,
              entryDate: candle.date,
              timestamp: candle.timestamp,
            };
            
            this.logger.debug(
              `${candle.date}: Открыта SHORT позиция. Цена: ${entryPrice}, ` +
              `SL: ${stopLoss}, TP: ${takeProfit}, Размер: ${positionSize}`,
            );
          }
        }
      }
      
      // Закрываем позицию в конце теста, если она открыта
      if (position) {
        const lastCandle = historicalData[historicalData.length - 1];
        const positionSize = position.size;
        const exitPrice = lastCandle.close;
        let profit = 0;
        
        if (position.side === 'BUY') {
          profit = positionSize * (exitPrice - position.entryPrice);
        } else {
          profit = positionSize * (position.entryPrice - exitPrice);
        }
        
        balance += profit;
        
        const trade: Trade = {
          entryDate: position.entryDate,
          entryPrice: position.entryPrice,
          exitDate: lastCandle.date,
          exitPrice: exitPrice,
          side: position.side,
          profit: profit,
          profitPercent: (profit / (positionSize * position.entryPrice)) * 100,
          duration: (lastCandle.timestamp - position.timestamp) / (60 * 60 * 1000),
        };
        
        trades.push(trade);
      }
      
      // Рассчитываем метрики эффективности
      const totalProfit = balance - initialBalance;
      const profitPercent = (totalProfit / initialBalance) * 100;
      const winningTrades = trades.filter(t => t.profit > 0).length;
      const winRate = (winningTrades / trades.length) * 100 || 0;
      const maxDrawdownPercent = (maxDrawdown / maxBalance) * 100;
      
      // Вычисляем коэффициент Шарпа
      // Сначала рассчитаем дневные доходности
      const dailyReturns: number[] = [];
      let prevDayBalance = initialBalance;
      let currentDay = '';
      
      for (let i = 0; i < historicalData.length; i++) {
        const day = new Date(historicalData[i].timestamp).toISOString().slice(0, 10);
        
        if (day !== currentDay) {
          // Новый день
          if (currentDay !== '') {
            // Вычисляем доходность предыдущего дня
            const equityIndex = Math.min(i, equityCurve.length - 1);
            const dayReturn = (equityCurve[equityIndex] - prevDayBalance) / prevDayBalance;
            dailyReturns.push(dayReturn);
            prevDayBalance = equityCurve[equityIndex];
          }
          currentDay = day;
        }
      }
      
      // Вычисляем среднюю доходность и стандартное отклонение
      const avgReturn = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length || 0;
      const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / dailyReturns.length || 0;
      const stdDev = Math.sqrt(variance) || 0.00001; // Избегаем деления на ноль
      
      // Безрисковая ставка (примерно 0.02 или 2% годовых)
      const riskFreeRate = 0.02 / 365; // Дневная безрисковая ставка
      
      // Вычисляем коэффициент Шарпа (аннуализированный)
      const sharpeRatio = ((avgReturn - riskFreeRate) / stdDev) * Math.sqrt(365);
      
      // Формируем результат бэктеста
      const result: BacktestResult = {
        symbol,
        period: timeframe,
        startDate: new Date(startTime).toISOString(),
        endDate: new Date(endTime).toISOString(),
        initialBalance,
        finalBalance: balance,
        totalProfit,
        profitPercent,
        totalTrades: trades.length,
        winningTrades,
        losingTrades: trades.length - winningTrades,
        winRate,
        maxDrawdown,
        maxDrawdownPercent,
        sharpeRatio,
        trades,
        monthlyReturns,
        equityCurve,
      };
      
      this.logger.log(`Бэктест завершен для ${symbol}. Прибыль: ${totalProfit.toFixed(2)} (${profitPercent.toFixed(2)}%), Win Rate: ${winRate.toFixed(2)}%`);
      
      return result;
    } catch (error) {
      this.logger.error(`Ошибка при выполнении бэктеста: ${error.message}`);
      throw error;
    }
  }

  /**
   * Анализирует несколько пар, чтобы найти наиболее подходящие для торговли
   */
  async analyzePairs(
    symbols: string[],
    timeframe: string = '4h',
    lookbackDays: number = 30,
  ): Promise<PairMetrics[]> {
    try {
      this.logger.log(`Анализ ${symbols.length} торговых пар на таймфрейме ${timeframe}`);
      
      const endTime = Date.now();
      const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
      const results: PairMetrics[] = [];
      
      for (const symbol of symbols) {
        this.logger.log(`Анализируем пару ${symbol}`);
        
        try {
          // Загружаем исторические данные
          const historicalData = await this.fetchHistoricalData(symbol, timeframe, startTime, endTime);
          
          if (historicalData.length < 30) {
            this.logger.warn(`Недостаточно данных для анализа ${symbol}`);
            continue;
          }
          
          // Рассчитываем объем за 24 часа (среднее значение за последние сутки)
          const hoursIn24 = 24 / this.getTimeframeHours(timeframe);
          const lastDayVolumes = historicalData.slice(0, hoursIn24).map(c => c.volume);
          const volume24h = lastDayVolumes.reduce((sum, vol) => sum + vol, 0);
          
          // Рассчитываем волатильность (средний диапазон High-Low)
          const volatilities = historicalData.map(c => (c.high - c.low) / c.low * 100);
          const volatility = volatilities.reduce((sum, vol) => sum + vol, 0) / volatilities.length;
          
          // Оцениваем ликвидность (аппроксимация через объем / волатильность)
          const liquidity = volume24h / volatility;
          
          // Рассчитываем спред (аппроксимация)
          const estimatedSpread = volatility * 0.01; // Примерная оценка
          
          // Определяем силу тренда с использованием ADX
          const closes = historicalData.map(c => c.close);
          const highs = historicalData.map(c => c.high);
          const lows = historicalData.map(c => c.low);
          
          const adxInput = {
            high: highs,
            low: lows,
            close: closes,
            period: 14
          };
          
          const adxResult = techIndicators.ADX.calculate(adxInput);
          const lastAdx = adxResult[adxResult.length - 1];
          const plusDI = adxResult[adxResult.length - 1].pdi;
          const minusDI = adxResult[adxResult.length - 1].mdi;
          
          // Оцениваем тренд: от -100 (сильный нисходящий) до +100 (сильный восходящий)
          const trend = lastAdx.adx * (plusDI > minusDI ? 1 : -1);
          
          // Рассчитываем общую оценку пары (пример формулы, можно настроить под свои предпочтения)
          const score = (
            (volume24h > 1000000 ? 30 : volume24h / 33333) +  // До 30 баллов за объем
            (volatility * 2) +                               // До 20 баллов за волатильность
            (liquidity > 1000000 ? 20 : liquidity / 50000) + // До 20 баллов за ликвидность
            (estimatedSpread < 0.1 ? 10 : 1 / estimatedSpread) + // До 10 баллов за узкий спред
            (Math.abs(trend) > 25 ? 20 : Math.abs(trend) * 0.8)  // До 20 баллов за силу тренда
          );
          
          // Формируем результат
          results.push({
            symbol,
            volume24h,
            volatility,
            liquidity,
            spread: estimatedSpread,
            trend,
            score
          });
          
          this.logger.debug(`${symbol}: Оценка ${score.toFixed(2)}, Объем: $${volume24h.toFixed(2)}, Волатильность: ${volatility.toFixed(2)}%`);
        } catch (error) {
          this.logger.error(`Ошибка при анализе ${symbol}: ${error.message}`);
        }
      }
      
      // Сортируем пары по убыванию оценки
      const sortedResults = results.sort((a, b) => b.score - a.score);
      
      this.logger.log(`Анализ завершен. Топ пары: ${sortedResults.slice(0, 3).map(r => r.symbol).join(', ')}`);
      
      return sortedResults;
    } catch (error) {
      this.logger.error(`Ошибка при анализе пар: ${error.message}`);
      return [];
    }
  }

  /**
   * Оптимизирует параметры стратегии для указанной пары
   */
  async optimizeStrategy(
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime: number,
    initialBalance: number = 10000,
  ): Promise<any> {
    try {
      this.logger.log(`Запуск оптимизации стратегии для ${symbol} (${timeframe})`);
      
      // Формируем сетку параметров для оптимизации
      const positionSizes = [1, 2, 5, 10]; // % от баланса
      const stopLosses = [0.5, 1, 1.5, 2]; // %
      const takeProfits = [1, 2, 3, 4]; // %
      const rsiPeriods = [7, 14, 21];
      const rsiOverboughts = [65, 70, 75, 80];
      const rsiOversolds = [20, 25, 30, 35];
      const emaShortPeriods = [5, 9, 13];
      const emaLongPeriods = [21, 34, 55];
      
      let bestResult = null;
      let bestScore = -Infinity;
      
      // Простая решетчатая оптимизация (для демонстрации - в реальности это нужно распараллелить)
      // В этом примере мы оптимизируем только некоторые параметры для ускорения
      for (const positionSize of positionSizes) {
        for (const stopLoss of stopLosses) {
          for (const takeProfit of takeProfits) {
            this.logger.debug(`Тестирование параметров: Размер=${positionSize}%, SL=${stopLoss}%, TP=${takeProfit}%`);
            
            // Запускаем бэктест с текущими параметрами
            const result = await this.runBacktest(
              symbol,
              timeframe,
              startTime,
              endTime,
              initialBalance,
              positionSize,
              stopLoss,
              takeProfit,
            );
            
            // Рассчитываем комплексную оценку результата
            // Учитываем: прибыль, просадку, коэффициент Шарпа, % выигрышных сделок
            const score = 
              (result.profitPercent * 2) - 
              (result.maxDrawdownPercent * 3) + 
              (result.sharpeRatio * 10) + 
              (result.winRate * 0.5);
            
            this.logger.debug(
              `Результат: Прибыль=${result.profitPercent.toFixed(2)}%, ` +
              `Просадка=${result.maxDrawdownPercent.toFixed(2)}%, ` +
              `Шарп=${result.sharpeRatio.toFixed(2)}, ` +
              `WinRate=${result.winRate.toFixed(2)}%, ` +
              `Оценка=${score.toFixed(2)}`
            );
            
            // Обновляем лучший результат, если текущий лучше
            if (score > bestScore) {
              bestScore = score;
              bestResult = {
                ...result,
                parameters: {
                  positionSize,
                  stopLoss,
                  takeProfit,
                },
                score,
              };
              
              this.logger.log(`Новый лучший набор параметров: ${JSON.stringify(bestResult.parameters)}`);
            }
          }
        }
      }
      
      this.logger.log(`Оптимизация завершена. Лучший результат: ${JSON.stringify(bestResult.parameters)}`);
      this.logger.log(`Лучший результат: Прибыль=${bestResult.profitPercent.toFixed(2)}%, WinRate=${bestResult.winRate.toFixed(2)}%`);
      
      return bestResult;
    } catch (error) {
      this.logger.error(`Ошибка при оптимизации стратегии: ${error.message}`);
      throw error;
    }
  }

  /**
   * Проверяет устойчивость стратегии на разных временных периодах
   */
  async validateStrategyRobustness(
    symbol: string,
    timeframe: string,
    lookbackMonths: number = 12,
    positionSize: number = 5,
    stopLoss: number = 1,
    takeProfit: number = 2,
  ): Promise<any> {
    try {
      this.logger.log(`Проверка устойчивости стратегии для ${symbol} на ${lookbackMonths} месяцев`);
      
      const now = Date.now();
      const monthDuration = 30 * 24 * 60 * 60 * 1000;
      const results = [];
      
      // Проверяем стратегию на разных временных периодах
      for (let i = 1; i <= lookbackMonths; i++) {
        const endTime = now - (i - 1) * monthDuration;
        const startTime = endTime - monthDuration;
        
        this.logger.debug(`Тестирование периода ${new Date(startTime).toISOString()} - ${new Date(endTime).toISOString()}`);
        
        // Запускаем бэктест для текущего месяца
        const result = await this.runBacktest(
          symbol,
          timeframe,
          startTime,
          endTime,
          10000, // Фиксированный начальный баланс для каждого периода
          positionSize,
          stopLoss,
          takeProfit,
        );
        
        results.push({
          period: `${new Date(startTime).toLocaleDateString()} - ${new Date(endTime).toLocaleDateString()}`,
          profitPercent: result.profitPercent,
          trades: result.totalTrades,
          winRate: result.winRate,
          maxDrawdownPercent: result.maxDrawdownPercent,
          sharpeRatio: result.sharpeRatio,
        });
        
        this.logger.debug(`Результат периода: Прибыль=${result.profitPercent.toFixed(2)}%, WinRate=${result.winRate.toFixed(2)}%`);
      }
      
      // Анализируем результаты
      const profitPercents = results.map(r => r.profitPercent);
      const avgProfit = profitPercents.reduce((sum, p) => sum + p, 0) / profitPercents.length;
      const profitStdDev = Math.sqrt(
        profitPercents.reduce((sum, p) => sum + Math.pow(p - avgProfit, 2), 0) / profitPercents.length
      );
      
      const winRates = results.map(r => r.winRate);
      const avgWinRate = winRates.reduce((sum, w) => sum + w, 0) / winRates.length;
      
      const drawdowns = results.map(r => r.maxDrawdownPercent);
      const avgDrawdown = drawdowns.reduce((sum, d) => sum + d, 0) / drawdowns.length;
      
      const profitableMonths = profitPercents.filter(p => p > 0).length;
      const profitableMonthsPercent = (profitableMonths / lookbackMonths) * 100;
      
      // Рассчитываем коэффициент устойчивости (стабильности)
      const robustnessFactor = 
        (avgProfit > 0 ? 1 : 0) * 
        (avgProfit / (profitStdDev || 1)) * 
        (profitableMonthsPercent / 100);
      
      this.logger.log(`Средняя месячная прибыль: ${avgProfit.toFixed(2)}% (σ=${profitStdDev.toFixed(2)}%)`);
      this.logger.log(`Прибыльных месяцев: ${profitableMonths}/${lookbackMonths} (${profitableMonthsPercent.toFixed(2)}%)`);
      this.logger.log(`Коэффициент устойчивости: ${robustnessFactor.toFixed(4)}`);
      
      // Формируем итоговый результат
      return {
        symbol,
        timeframe,
        monthlyResults: results,
        summary: {
          avgProfitPercent: avgProfit,
          profitStdDev,
          avgWinRate,
          avgDrawdown,
          profitableMonths,
          profitableMonthsPercent,
          robustnessFactor,
        }
      };
    } catch (error) {
      this.logger.error(`Ошибка при проверке устойчивости стратегии: ${error.message}`);
      throw error;
    }
  }

  /**
   * Получает количество часов в таймфрейме
   */
  private getTimeframeHours(timeframe: string): number {
    const match = timeframe.match(/(\d+)([hmd])/);
    if (!match) return 1;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 'm': return value / 60;
      case 'h': return value;
      case 'd': return value * 24;
      default: return 1;
    }
  }

  /**
   * Рассчитывает RSI для массива цен закрытия
   */
  private calculateRSI(prices: number[], period: number): number[] {
    const inputRSI = {
      values: prices,
      period: period,
    };
    
    return techIndicators.RSI.calculate(inputRSI);
  }

  /**
   * Рассчитывает EMA для массива цен закрытия
   */
  private calculateEMA(prices: number[], period: number): number[] {
    const inputEMA = {
      values: prices,
      period: period,
    };
    
    return techIndicators.EMA.calculate(inputEMA);
  }

  /**
   * Генерирует отчет о бэктесте в HTML формате
   */
  generateBacktestReport(result: BacktestResult): string {
    const report = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Отчет о бэктесте для ${result.symbol}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .header { text-align: center; margin-bottom: 30px; }
          .summary { margin-bottom: 30px; }
          .metrics { display: flex; flex-wrap: wrap; }
          .metric { width: 25%; padding: 10px; box-sizing: border-box; }
          .metric-value { font-size: 24px; font-weight: bold; }
          .metric-label { font-size: 14px; color: #666; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
          th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
          th { background-color: #f2f2f2; }
          .positive { color: green; }
          .negative { color: red; }
          .chart { height: 400px; margin-bottom: 30px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Отчет о бэктесте для ${result.symbol}</h1>
          <p>Период: ${result.startDate} - ${result.endDate}</p>
        </div>
        
        <div class="summary">
          <h2>Общие результаты</h2>
          
          <div class="metrics">
            <div class="metric">
              <div class="metric-value ${result.totalProfit >= 0 ? 'positive' : 'negative'}">
                ${result.totalProfit.toFixed(2)} USD
              </div>
              <div class="metric-label">Общая прибыль</div>
            </div>
            
            <div class="metric">
              <div class="metric-value ${result.profitPercent >= 0 ? 'positive' : 'negative'}">
                ${result.profitPercent.toFixed(2)}%
              </div>
              <div class="metric-label">Процент прибыли</div>
            </div>
            
            <div class="metric">
              <div class="metric-value">
                ${result.winRate.toFixed(2)}%
              </div>
              <div class="metric-label">Процент выигрышных сделок</div>
            </div>
            
            <div class="metric">
              <div class="metric-value">
                ${result.totalTrades}
              </div>
              <div class="metric-label">Всего сделок</div>
            </div>
            
            <div class="metric">
              <div class="metric-value negative">
                -${result.maxDrawdownPercent.toFixed(2)}%
              </div>
              <div class="metric-label">Максимальная просадка</div>
            </div>
            
            <div class="metric">
              <div class="metric-value ${result.sharpeRatio >= 1 ? 'positive' : result.sharpeRatio >= 0 ? '' : 'negative'}">
                ${result.sharpeRatio.toFixed(2)}
              </div>
              <div class="metric-label">Коэффициент Шарпа</div>
            </div>
          </div>
        </div>
        
        <h2>Кривая капитала</h2>
        <div class="chart">
          <canvas id="equityChart"></canvas>
        </div>
        
        <h2>Ежемесячные результаты</h2>
        <div class="chart">
          <canvas id="monthlyChart"></canvas>
        </div>
        
        <h2>Лучшие сделки</h2>
        <table>
          <tr>
            <th>Вход</th>
            <th>Цена входа</th>
            <th>Выход</th>
            <th>Цена выхода</th>
            <th>Сторона</th>
            <th>Прибыль</th>
            <th>Прибыль (%)</th>
            <th>Длительность (ч)</th>
          </tr>
          ${result.trades
            .sort((a, b) => b.profitPercent - a.profitPercent)
            .slice(0, 10)
            .map(trade => `
              <tr>
                <td>${new Date(trade.entryDate).toLocaleString()}</td>
                <td>${trade.entryPrice.toFixed(2)}</td>
                <td>${new Date(trade.exitDate).toLocaleString()}</td>
                <td>${trade.exitPrice.toFixed(2)}</td>
                <td>${trade.side}</td>
                <td class="${trade.profit >= 0 ? 'positive' : 'negative'}">${trade.profit.toFixed(2)}</td>
                <td class="${trade.profitPercent >= 0 ? 'positive' : 'negative'}">${trade.profitPercent.toFixed(2)}%</td>
                <td>${trade.duration.toFixed(2)}</td>
              </tr>
            `).join('')}
        </table>
        
        <h2>Худшие сделки</h2>
        <table>
          <tr>
            <th>Вход</th>
            <th>Цена входа</th>
            <th>Выход</th>
            <th>Цена выхода</th>
            <th>Сторона</th>
            <th>Прибыль</th>
            <th>Прибыль (%)</th>
            <th>Длительность (ч)</th>
          </tr>
          ${result.trades
            .sort((a, b) => a.profitPercent - b.profitPercent)
            .slice(0, 10)
            .map(trade => `
              <tr>
                <td>${new Date(trade.entryDate).toLocaleString()}</td>
                <td>${trade.entryPrice.toFixed(2)}</td>
                <td>${new Date(trade.exitDate).toLocaleString()}</td>
                <td>${trade.exitPrice.toFixed(2)}</td>
                <td>${trade.side}</td>
                <td class="${trade.profit >= 0 ? 'positive' : 'negative'}">${trade.profit.toFixed(2)}</td>
                <td class="${trade.profitPercent >= 0 ? 'positive' : 'negative'}">${trade.profitPercent.toFixed(2)}%</td>
                <td>${trade.duration.toFixed(2)}</td>
              </tr>
            `).join('')}
        </table>
        
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <script>
          // Кривая капитала
          const equityCtx = document.getElementById('equityChart').getContext('2d');
          new Chart(equityCtx, {
            type: 'line',
            data: {
              labels: Array.from({length: ${result.equityCurve.length}}, (_, i) => i),
              datasets: [{
                label: 'Капитал',
                data: ${JSON.stringify(result.equityCurve)},
                borderColor: 'blue',
                tension: 0.1
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                y: {
                  beginAtZero: false
                }
              }
            }
          });
          
          // Ежемесячные результаты
          const monthlyData = ${JSON.stringify(Object.entries(result.monthlyReturns))};
          const monthlyCtx = document.getElementById('monthlyChart').getContext('2d');
          new Chart(monthlyCtx, {
            type: 'bar',
            data: {
              labels: monthlyData.map(item => item[0]),
              datasets: [{
                label: 'Ежемесячная доходность (%)',
                data: monthlyData.map(item => item[1]),
                backgroundColor: monthlyData.map(item => item[1] >= 0 ? 'rgba(75, 192, 192, 0.5)' : 'rgba(255, 99, 132, 0.5)'),
                borderColor: monthlyData.map(item => item[1] >= 0 ? 'rgba(75, 192, 192, 1)' : 'rgba(255, 99, 132, 1)'),
                borderWidth: 1
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                y: {
                  beginAtZero: false
                }
              }
            }
          });
        </script>
      </body>
      </html>
    `;
    
    return report;
  }
}