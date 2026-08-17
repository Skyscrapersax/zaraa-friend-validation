/* manual type definitions for @zaraa/predict */

export function ping(): string;

export interface PredictConfig {
  dbPath: string;
  dataDir: string;
}

export class ZaraaPredict {
  constructor(config: PredictConfig);
  refreshData(): Promise<string>;
  train(forceRetrain?: boolean | undefined | null): Promise<string>;
  predict(symbol: string, horizon: string): Promise<string>;
  fullReport(horizon: string): Promise<string>;
  regimeForecast(): Promise<string>;
  rotation(horizon: string): Promise<string>;
  correlationMatrix(window: number): Promise<string>;
  modelMetrics(): Promise<string>;
}
