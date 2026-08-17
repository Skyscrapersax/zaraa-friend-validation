/**
 * Adapter that bridges Zaraa's ModelRouter into the LLMForecaster's ModelCaller interface.
 *
 * The forecaster expects: (model: string, prompt: string) => Promise<string>
 * The ModelRouter provides: getProvider(zone, taskType) → LLMProvider with .chat()
 *
 * This adapter creates a ModelCaller function that:
 * 1. Resolves the named model to a provider via ModelRouter
 * 2. Sends the prompt as a user message via chat()
 * 3. Returns the text response
 */
import type { ModelCaller } from "./llm-forecaster.js";

export interface ModelCallerAdapterDeps {
	/** Get a provider by model name — typically ModelRouter.getProviderByName() */
	getProviderByName: (name: string) => { chat: (messages: Array<{ role: string; content: string }>, tools?: unknown[]) => Promise<{ content: string }> } | undefined;
	/** Fallback provider for unknown model names — typically ModelRouter.getProvider(zone, "deep") */
	getFallbackProvider: () => { chat: (messages: Array<{ role: string; content: string }>, tools?: unknown[]) => Promise<{ content: string }> };
}

/**
 * Create a ModelCaller function from a ModelRouter (or any provider lookup).
 * Used to connect the LLMForecaster to live model inference.
 */
export function createModelCaller(deps: ModelCallerAdapterDeps): ModelCaller {
	return async (model: string, prompt: string): Promise<string> => {
		const provider = deps.getProviderByName(model) ?? deps.getFallbackProvider();

		const response = await provider.chat([
			{ role: "user", content: prompt },
		]);

		return response.content ?? "";
	};
}
