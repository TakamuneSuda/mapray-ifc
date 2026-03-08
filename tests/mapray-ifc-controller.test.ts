import { describe, expect, it } from 'vitest';
import { MaprayIfcController } from '../src/lib/mapray-ifc-controller';
import type { IfcWorkerSuccessMessage } from '../src/lib/ifc-worker-types';

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});

	return { promise, resolve, reject };
}

class FakeResource {
	static Type = {
		JSON: 1,
		TEXT: 2,
		BINARY: 3
	};
}

class FakeModelEntity {
	altitude_mode: string | null = null;

	setPosition(position: unknown): void {
		void position;
	}

	setOrientation(orientation: unknown): void {
		void orientation;
	}

	setScale(scale: unknown): void {
		void scale;
	}
}

class FakeScene {
	entities: FakeModelEntity[] = [];

	addEntity(entity: FakeModelEntity): void {
		this.entities.push(entity);
	}

	removeEntity(entity: FakeModelEntity): void {
		this.entities = this.entities.filter((entry) => entry !== entity);
	}
}

type LoaderOptions = {
	onEntity?: (loader: FakeSceneLoader, entity: FakeModelEntity, item: object) => void;
};

class FakeSceneLoader {
	static behavior: (loader: FakeSceneLoader) => Promise<void> = async () => {};

	readonly scene: FakeScene;
	readonly resource: unknown;
	readonly options: LoaderOptions;
	canceled = false;

	constructor(scene: FakeScene, resource: unknown, options: LoaderOptions = {}) {
		this.scene = scene;
		this.resource = resource;
		this.options = options;
	}

	async load(): Promise<void> {
		await FakeSceneLoader.behavior(this);
	}

	cancel(): void {
		this.canceled = true;
	}
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

class FakeGeoPoint {
	longitude: number;
	latitude: number;
	altitude: number;

	constructor(longitude = 0, latitude = 0, altitude = 0) {
		this.longitude = longitude;
		this.latitude = latitude;
		this.altitude = altitude;
	}

	getAsGocs(): [number, number, number] {
		return [this.longitude, this.latitude, this.altitude];
	}

	setFromGocs(position: [number, number, number]): FakeGeoPoint {
		this.longitude = position[0];
		this.latitude = position[1];
		this.altitude = position[2];
		return this;
	}

	getMlocsToGocsMatrix(): number[] {
		return [...IDENTITY_MATRIX];
	}
}

class FakeOrientation {
	constructor(
		readonly heading = 0,
		readonly tilt = 0,
		readonly roll = 0
	) {}

	getTransformMatrix(): number[] {
		return [...IDENTITY_MATRIX];
	}
}

class FakeViewer {
	readonly scene = new FakeScene();
	pickCalls = 0;

	pick(): null {
		this.pickCalls += 1;
		return null;
	}
}

type MessageListener = (event: MessageEvent<IfcWorkerSuccessMessage>) => void;
type ErrorListener = (event: ErrorEvent) => void;

class FakeWorker {
	readonly #messageListeners = new Set<MessageListener>();
	readonly #errorListeners = new Set<ErrorListener>();
	onPostMessage?: (message: Record<string, unknown>) => void;
	lastMessage: Record<string, unknown> | null = null;
	terminated = false;

	addEventListener(type: 'message' | 'error', listener: MessageListener | ErrorListener): void {
		if (type === 'message') {
			this.#messageListeners.add(listener as MessageListener);
			return;
		}

		this.#errorListeners.add(listener as ErrorListener);
	}

	postMessage(message: Record<string, unknown>): void {
		this.lastMessage = message;
		this.onPostMessage?.(message);
	}

	terminate(): void {
		this.terminated = true;
	}

	emitMessage(message: IfcWorkerSuccessMessage): void {
		for (const listener of this.#messageListeners) {
			listener({ data: message } as MessageEvent<IfcWorkerSuccessMessage>);
		}
	}

	emitError(message = 'IFC worker failed.'): void {
		for (const listener of this.#errorListeners) {
			listener({ message } as ErrorEvent);
		}
	}
}

function createMaprayModule() {
	return {
		Resource: FakeResource,
		ModelEntity: FakeModelEntity,
		SceneLoader: FakeSceneLoader,
		GeoPoint: FakeGeoPoint,
		GeoMath: {
			createVector3: () => [0, 0, 0],
			createMatrix: () => [...IDENTITY_MATRIX],
			inverse_A: () => [...IDENTITY_MATRIX],
			transformPosition_A: (_matrix: unknown, position: [number, number, number]) => [...position],
			mul_AA: () => [...IDENTITY_MATRIX]
		},
		Orientation: FakeOrientation,
		AltitudeMode: {
			ABSOLUTE: 'absolute'
		}
	} as unknown as typeof import('@mapray/mapray-js').default;
}

function createWorkerSuccessMessage(requestId: number): IfcWorkerSuccessMessage {
	return {
		type: 'success',
		requestId,
		scenePackage: {
			entryPath: 'scene.json',
			resources: {
				'scene.json': {
					json: {
						entity_list: []
					}
				}
			}
		},
		stats: {
			elementCount: 1,
			meshCount: 1,
			vertexCount: 3,
			triangleCount: 1,
			bounds: {
				min: [0, 0, 0],
				max: [1, 1, 1],
				size: [1, 1, 1],
				radius: 0.5
			}
		},
		elements: [
			{
				expressID: 1,
				entityId: 'ifc-element-1',
				type: 'IfcWall',
				globalId: 'wall-1',
				name: 'Wall',
				description: null,
				objectType: null,
				tag: null,
				predefinedType: null,
				propertyGroups: [],
				bounds: {
					min: [0, 0, 0],
					max: [1, 1, 1],
					center: [0.5, 0.5, 0.5],
					size: [1, 1, 1],
					volume: 1
				}
			}
		],
		chunks: [
			{
				entityId: 'ifc-chunk-0',
				elementExpressIds: [1]
			}
		],
		metrics: {
			parseIfcMs: 1,
			gltfTransformMs: 1,
			totalMs: 2
		}
	};
}

describe('MaprayIfcController', () => {
	it('skips viewer.pick when no IFC entities are loaded', () => {
		const viewer = new FakeViewer();
		const controller = new MaprayIfcController({
			mapray: createMaprayModule(),
			viewer: viewer as never,
			workerFactory: () => new FakeWorker() as never
		});

		expect(controller.pick([10, 20])).toEqual({
			element: null,
			entity: null,
			worldPosition: null,
			elapsedMs: 0
		});
		expect(viewer.pickCalls).toBe(0);
	});

	it('forwards wasmPath to the worker request', async () => {
		const worker = new FakeWorker();
		const viewer = new FakeViewer();

		FakeSceneLoader.behavior = async (loader) => {
			loader.options.onEntity?.(loader, new FakeModelEntity(), { id: 'ifc-chunk-0' });
		};
		worker.onPostMessage = (message) => {
			worker.emitMessage(createWorkerSuccessMessage(message.requestId as number));
		};

		const controller = new MaprayIfcController({
			mapray: createMaprayModule(),
			viewer: viewer as never,
			workerFactory: () => worker as never,
			wasmPath: 'https://cdn.example.com/wasm/'
		});

		await controller.load(new ArrayBuffer(8));

		expect(worker.lastMessage?.wasmPath).toBe('https://cdn.example.com/wasm/');
	});

	it('rejects a second load while SceneLoader.load is still running', async () => {
		const worker = new FakeWorker();
		const viewer = new FakeViewer();
		const deferred = createDeferred<void>();

		FakeSceneLoader.behavior = async (loader) => {
			loader.options.onEntity?.(loader, new FakeModelEntity(), { id: 'ifc-chunk-0' });
			await deferred.promise;
		};
		worker.onPostMessage = (message) => {
			worker.emitMessage(createWorkerSuccessMessage(message.requestId as number));
		};

		const controller = new MaprayIfcController({
			mapray: createMaprayModule(),
			viewer: viewer as never,
			workerFactory: () => worker as never
		});

		const firstLoad = controller.load(new ArrayBuffer(8));
		const secondLoad = controller.load(new ArrayBuffer(8));

		await expect(secondLoad).rejects.toThrow('Another IFC file is already being loaded.');

		deferred.resolve();
		await expect(firstLoad).resolves.toMatchObject({ loadedEntityCount: 1 });
	});

	it('removes partially added entities when SceneLoader.load fails', async () => {
		const worker = new FakeWorker();
		const viewer = new FakeViewer();

		FakeSceneLoader.behavior = async (loader) => {
			loader.options.onEntity?.(loader, new FakeModelEntity(), { id: 'ifc-chunk-0' });
			throw new Error('Scene load failed.');
		};
		worker.onPostMessage = (message) => {
			worker.emitMessage(createWorkerSuccessMessage(message.requestId as number));
		};

		const controller = new MaprayIfcController({
			mapray: createMaprayModule(),
			viewer: viewer as never,
			workerFactory: () => worker as never
		});

		await expect(controller.load(new ArrayBuffer(8))).rejects.toThrow('Scene load failed.');
		expect(viewer.scene.entities).toHaveLength(0);
		expect(controller.loadedEntityCount).toBe(0);
	});

	it('recreates the worker after a native worker error', async () => {
		const workers = [new FakeWorker(), new FakeWorker()];
		const viewer = new FakeViewer();
		let workerFactoryCalls = 0;

		FakeSceneLoader.behavior = async (loader) => {
			loader.options.onEntity?.(loader, new FakeModelEntity(), { id: 'ifc-chunk-0' });
		};
		workers[0].onPostMessage = () => {
			workers[0].emitError('Worker boot failed.');
		};
		workers[1].onPostMessage = (message) => {
			workers[1].emitMessage(createWorkerSuccessMessage(message.requestId as number));
		};

		const controller = new MaprayIfcController({
			mapray: createMaprayModule(),
			viewer: viewer as never,
			workerFactory: () => {
				const worker = workers[workerFactoryCalls];
				workerFactoryCalls += 1;

				return worker as never;
			}
		});

		await expect(controller.load(new ArrayBuffer(8))).rejects.toThrow('Worker boot failed.');
		await expect(controller.load(new ArrayBuffer(8))).resolves.toMatchObject({
			loadedEntityCount: 1
		});
		expect(workers[0].terminated).toBe(true);
		expect(workerFactoryCalls).toBe(2);
	});
});
