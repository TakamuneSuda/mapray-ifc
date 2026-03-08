import { createIfcScenePackage } from './gltf-builder';
import { extractGeometry } from './ifc-loader';
import type { IfcWorkerRequest, IfcWorkerResponse } from './ifc-worker-types';

type WorkerScope = {
	postMessage: (message: IfcWorkerResponse, transfer?: Transferable[]) => void;
	onmessage: ((event: MessageEvent<IfcWorkerRequest>) => void | Promise<void>) | null;
};

const workerScope = self as unknown as WorkerScope;

function postMessageFromWorker(message: IfcWorkerResponse, transfer: Transferable[] = []): void {
	workerScope.postMessage(message, transfer);
}

workerScope.onmessage = async (event: MessageEvent<IfcWorkerRequest>) => {
	const request = event.data;

	if (request.type !== 'load-ifc') {
		return;
	}

	try {
		const totalStart = performance.now();

		postMessageFromWorker({
			type: 'progress',
			requestId: request.requestId,
			message: 'Parsing IFC with web-ifc...'
		});

		const parseIfcStart = performance.now();
		const model = await extractGeometry(new Uint8Array(request.data), request.wasmPath);
		const parseIfcMs = performance.now() - parseIfcStart;

		postMessageFromWorker({
			type: 'progress',
			requestId: request.requestId,
			message: 'Converting IFC mesh to glTF...'
		});

		const gltfTransformStart = performance.now();
		const { scenePackage, chunks } = await createIfcScenePackage(model);
		const gltfTransformMs = performance.now() - gltfTransformStart;
		const transferables = Object.values(scenePackage.resources)
			.map((resource) => resource.binary)
			.filter((binary): binary is ArrayBuffer => binary instanceof ArrayBuffer);

		postMessageFromWorker(
			{
				type: 'success',
				requestId: request.requestId,
				scenePackage,
				stats: model.stats,
				elements: model.elements.map((element) => element.metadata),
				chunks,
				metrics: {
					parseIfcMs,
					gltfTransformMs,
					totalMs: performance.now() - totalStart
				}
			},
			transferables
		);
	} catch (error) {
		postMessageFromWorker({
			type: 'error',
			requestId: request.requestId,
			error: error instanceof Error ? error.message : 'IFC processing failed.'
		});
	}
};
