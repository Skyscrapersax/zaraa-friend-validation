let predictor: any = null;

export async function getPredictor(): Promise<any | null> {
	if (predictor) return predictor;
	try {
		const { ZaraaPredict } = await import("@zaraa/predict");
		predictor = new ZaraaPredict({
			dbPath: `${process.env.HOME}/.zaraa/predict-cache.db`,
			dataDir: `${process.env.HOME}/.zaraa/models/`,
		});
		return predictor;
	} catch {
		// Native addon not available — fallback to TS pipeline
		return null;
	}
}
