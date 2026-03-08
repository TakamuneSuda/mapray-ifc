import type { IfcWorkerResponse, IfcWorkerSuccessMessage } from './ifc-worker-types';

type PendingRequest = {
	requestId: number;
	resolve: (message: IfcWorkerSuccessMessage) => void;
	reject: (error: Error) => void;
};

export interface IfcWorkerClient {
	process(data: ArrayBuffer, wasmPath?: string): Promise<IfcWorkerSuccessMessage>;
	cancel(): void;
	destroy(): void;
}

export function createIfcWorkerClient(options: {
	workerFactory: () => Worker;
	onProgress?: (message: string) => void;
}): IfcWorkerClient {
	let worker: Worker | null = null;
	let pendingRequest: PendingRequest | null = null;
	let nextRequestId = 1;

	const resetWorker = () => {
		worker?.terminate();
		worker = null;
	};

	const handleWorkerMessage = (event: MessageEvent<IfcWorkerResponse>): void => {
		const message = event.data;

		if (!pendingRequest || message.requestId !== pendingRequest.requestId) {
			return;
		}

		if (message.type === 'progress') {
			options.onProgress?.(message.message);
			return;
		}

		if (message.type === 'error') {
			const { reject } = pendingRequest;
			pendingRequest = null;
			reject(new Error(message.error));
			return;
		}

		const { resolve } = pendingRequest;
		pendingRequest = null;
		resolve(message);
	};

	const ensureWorker = (): Worker => {
		if (!worker) {
			worker = options.workerFactory();
			worker.addEventListener('message', handleWorkerMessage);
			worker.addEventListener('error', (event) => {
				resetWorker();

				if (!pendingRequest) {
					return;
				}

				const { reject } = pendingRequest;
				pendingRequest = null;
				const location =
					event.filename && event.lineno
						? ` (${event.filename}:${event.lineno}${event.colno ? `:${event.colno}` : ''})`
						: '';
				reject(new Error(`${event.message || 'IFC worker failed.'}${location}`));
			});
		}

		return worker;
	};

	return {
		async process(data: ArrayBuffer, wasmPath?: string): Promise<IfcWorkerSuccessMessage> {
			if (pendingRequest) {
				throw new Error('Another IFC file is already being processed.');
			}

			const requestId = nextRequestId;
			nextRequestId += 1;

			return await new Promise<IfcWorkerSuccessMessage>((resolve, reject) => {
				pendingRequest = { requestId, resolve, reject };
				ensureWorker().postMessage(
					{
						type: 'load-ifc',
						requestId,
						data,
						wasmPath
					},
					[data]
				);
			});
		},
		cancel(): void {
			if (!pendingRequest) {
				return;
			}

			const { reject } = pendingRequest;
			pendingRequest = null;
			reject(new Error('IFC loading was canceled.'));
			resetWorker();
		},
		destroy(): void {
			this.cancel();
			resetWorker();
		}
	};
}
