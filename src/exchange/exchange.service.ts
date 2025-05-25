import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RestClientV5, WebsocketClient, KlineInterval, PositionIdx, KlineIntervalV3 } from 'bybit-api';

@Injectable()
export class ExchangeService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeService.name);
  private restClient: RestClientV5;
  private wsClient: WebsocketClient;
  private symbol: string;

  constructor(private configService: ConfigService) {
    this.symbol = this.configService.get<string>('SYMBOL') || 'BTCUSDT';
    
    const apiKey = 'uiI0niHkyPjVEFFwK9';
    const apiSecret = '4rqydf7wPFX1dkqHGDowMtdWH4vXEXIGUnls';
    const useTestnet = false;
    
    this.restClient = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      testnet: useTestnet,
      demoTrading: true,
    });

    this.wsClient = new WebsocketClient({
      key: apiKey,
      secret: apiSecret,
      testnet: useTestnet,
      demoTrading: true,
    });
  }

  async onModuleInit() {
    await this.setupWebsocket();
    this.logger.log(`Подключение к Bybit для торговли ${this.symbol} установлено`);
  }

  private async setupWebsocket() {
    this.wsClient.subscribeV5([`publicTrade.${this.symbol}`], 'linear');
    
    this.wsClient.on('update', (data) => {
      // Обработка обновлений в реальном времени, если требуется
      // this.logger.debug(`Обновление WebSocket: ${JSON.stringify(data)}`);
    });
    
    (this.wsClient as any).on('error', (err: any) => {
      this.logger.error(`Ошибка WebSocket: ${err.message}`);
    });
    
    this.wsClient.on('close', () => {
      this.logger.warn('WebSocket соединение закрыто, переподключение...');
      setTimeout(() => this.setupWebsocket(), 5000);
    });
  }

  async getAccountBalance() {
    try {
      const response = await this.restClient.getWalletBalance({
        accountType: 'CONTRACT',
        coin: 'USDT',
      });
      
      if (response.retCode === 0) {
        this.logger.log(`Баланс аккаунта: ${JSON.stringify(response.result)}`);
        return response.result;
      } else {
        this.logger.error(`Ошибка при получении баланса: ${response.retMsg}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Исключение при получении баланса: ${error.message}`);
      return null;
    }
  }

  async getKlines(interval: string, limit: number = 100, startTime?: number) {
    try {
      const klineInterval = this.convertToKlineInterval(interval);

      const params: any = {
        category: 'linear',
        symbol: this.symbol,
        interval: klineInterval,
        limit,
      };
      
      if (startTime) {
        params.start = startTime;
      }
      
      const response = await this.restClient.getKline(params);

      if (response.retCode === 0) {
        return response.result.list;
      } else {
        this.logger.error(`Ошибка при получении свечей: ${response.retMsg}`);
        return [];
      }
    } catch (error) {
      this.logger.error(`Исключение при получении свечей: ${error.message}`);
      return [];
    }
  }

  private convertToKlineInterval(interval: string): KlineIntervalV3 {
    const map: { [key: string]: KlineIntervalV3 } = {
      '1m': '1',
      '3m': '3',
      '5m': '5',
      '15m': '15',
      '30m': '30',
      '1h': '60',
      '2h': '120',
      '4h': '240',
      '6h': '360',
      '12h': '720',
      '1d': 'D',
      '1w': 'W',
      '1M': 'M',
    };

    return map[interval] || '60';
  }

  async placeOrder(side: 'Buy' | 'Sell', quantity: string, price?: string) {
    try {
      const orderType = price ? 'Limit' : 'Market';
      
      const orderParams: any = {
        category: 'linear',
        symbol: this.symbol,
        side,
        orderType,
        qty: quantity,
        timeInForce: orderType === 'Market' ? 'IOC' : 'GTC',
      };
      
      if (price) {
        orderParams.price = price;
      }
      
      const response = await this.restClient.submitOrder(orderParams);
      
      if (response.retCode === 0) {
        this.logger.log(`Ордер размещен: ${JSON.stringify(response.result)}`);
        return response.result;
      } else {
        this.logger.error(`Ошибка при размещении ордера: ${response.retMsg}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Исключение при размещении ордера: ${error.message}`);
      return null;
    }
  }

  async getPositions() {
    try {
      const response = await this.restClient.getPositionInfo({
        category: 'linear',
        symbol: this.symbol,
      });

      if (response.retCode === 0) {
        return response.result.list;
      } else {
        this.logger.error(`Ошибка при получении позиций: ${response.retMsg}`);
        return [];
      }
    } catch (error) {
      this.logger.error(`Исключение при получении позиций: ${error.message}`);
      return [];
    }
  }

  async setTradingStop(positionIdx: PositionIdx, stopLoss: string, takeProfit: string) {
    try {
      const response = await this.restClient.setTradingStop({
        category: 'linear',
        symbol: this.symbol,
        positionIdx: positionIdx,
        stopLoss,
        takeProfit,
        tpslMode: 'Full',
        slOrderType: 'Limit',
        tpOrderType: 'Limit',
      });
      if (response.retCode === 0) {
        this.logger.log(`Стоп-лосс и тейк-профит установлены`);
        return true;
      }
      this.logger.error(`Ошибка установки стоп-лосса: ${response.retMsg}`);
      return false;
    } catch (error) {
      this.logger.error(`Ошибка установки стоп-лосса: ${error.message}`);
      return false;
    }
  }

  async closePosition(positionIdx: string, side: 'Buy' | 'Sell', quantity: string) {
    try {
      const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
      const response = await this.restClient.submitOrder({
        category: 'linear',
        symbol: this.symbol,
        side: closeSide,
        orderType: 'Market',
        qty: quantity,
        reduceOnly: true,
      });
      
      if (response.retCode === 0) {
        this.logger.log(`Позиция закрыта: ${JSON.stringify(response.result)}`);
        return response.result;
      } else {
        this.logger.error(`Ошибка при закрытии позиции: ${response.retMsg}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Исключение при закрытии позиции: ${error.message}`);
      return null;
    }
  }
}