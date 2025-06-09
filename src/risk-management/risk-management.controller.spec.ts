import { Test, TestingModule } from '@nestjs/testing';
import { RiskManagmentController } from './risk-management.controller';

describe('RiskManagmentController', () => {
  let controller: RiskManagmentController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RiskManagmentController],
    }).compile();

    controller = module.get<RiskManagmentController>(RiskManagmentController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
