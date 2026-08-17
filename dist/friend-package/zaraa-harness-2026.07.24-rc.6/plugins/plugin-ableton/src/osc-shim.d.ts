declare module "osc" {
	export class UDPPort {
		constructor(options: Record<string, unknown>);
		on(event: string, listener: (...args: unknown[]) => void): void;
		open(): void;
		send(packet: unknown, host?: string, port?: number): void;
		close(): void;
	}
}
