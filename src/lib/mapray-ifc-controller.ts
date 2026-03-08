import type { ScenePackage } from './gltf-builder';
import {
	type IfcElementBounds,
	type IfcElementMetadata,
	type ExtractedModelStats
} from './ifc-loader';
import type {
	IfcProcessingMetrics,
	IfcWorkerResponse,
	IfcWorkerSuccessMessage
} from './ifc-worker-types';
import { createMemoryResource } from './memory-resource';

type MaprayModule = typeof import('@mapray/mapray-js').default;
type MaprayViewerInstance = InstanceType<MaprayModule['Viewer']>;
type MaprayModelEntityInstance = InstanceType<MaprayModule['ModelEntity']>;
type SceneLoaderInstance = InstanceType<MaprayModule['SceneLoader']>;
type Vector3 = [number, number, number];

const DEFAULT_MODEL_OFFSET_TILT = -90;
const DEFAULT_BOUNDS_EPSILON = 0.05;

type SceneAsset = ScenePackage & { revoke(): void };

export interface IfcModelTransform {
	longitude: number;
	latitude: number;
	height: number;
	heading: number;
	tilt: number;
	roll: number;
	scale: number;
}

export interface MaprayIfcControllerOptions {
	mapray: MaprayModule;
	viewer: MaprayViewerInstance;
	workerFactory?: () => Worker;
	onProgress?: (message: string) => void;
	modelOffsetTilt?: number;
	boundsEpsilon?: number;
	wasmPath?: string;
}

export interface MaprayIfcLoadOptions {
	fileSizeBytes?: number;
}

export interface MaprayIfcLoadResult {
	stats: ExtractedModelStats;
	elements: IfcElementMetadata[];
	metrics: IfcProcessingMetrics;
	maprayLoadMs: number;
	totalLoadMs: number;
	loadedEntityCount: number;
	chunkCount: number;
	sceneResourceCount: number;
	sceneBinaryBytes: number;
	fileSizeBytes: number | null;
}

export interface MaprayIfcPickResult {
	element: IfcElementMetadata | null;
	entity: MaprayModelEntityInstance | null;
	worldPosition: Vector3 | null;
	elapsedMs: number;
}

function createSceneAsset(scenePackage: ScenePackage): SceneAsset {
	return {
		...scenePackage,
		revoke() {}
	};
}

function getBinaryResourceBytes(scenePackage: ScenePackage): number {
	return Object.values(scenePackage.resources).reduce((total, resource) => {
		return total + (resource.binary?.byteLength ?? 0);
	}, 0);
}

function isPointInsideBounds(point: Vector3, bounds: IfcElementBounds, epsilon: number): boolean {
	return (
		point[0] >= bounds.min[0] - epsilon &&
		point[0] <= bounds.max[0] + epsilon &&
		point[1] >= bounds.min[1] - epsilon &&
		point[1] <= bounds.max[1] + epsilon &&
		point[2] >= bounds.min[2] - epsilon &&
		point[2] <= bounds.max[2] + epsilon
	);
}

function getBoundsDistanceSquared(point: Vector3, bounds: IfcElementBounds): number {
	const dx =
		point[0] < bounds.min[0]
			? bounds.min[0] - point[0]
			: point[0] > bounds.max[0]
				? point[0] - bounds.max[0]
				: 0;
	const dy =
		point[1] < bounds.min[1]
			? bounds.min[1] - point[1]
			: point[1] > bounds.max[1]
				? point[1] - bounds.max[1]
				: 0;
	const dz =
		point[2] < bounds.min[2]
			? bounds.min[2] - point[2]
			: point[2] > bounds.max[2]
				? point[2] - bounds.max[2]
				: 0;

	return dx * dx + dy * dy + dz * dz;
}

function getCenterDistanceSquared(point: Vector3, bounds: IfcElementBounds): number {
	const dx = point[0] - bounds.center[0];
	const dy = point[1] - bounds.center[1];
	const dz = point[2] - bounds.center[2];

	return dx * dx + dy * dy + dz * dz;
}

type PendingRequest = {
	requestId: number;
	resolve: (message: IfcWorkerSuccessMessage) => void;
	reject: (error: Error) => void;
};

export class MaprayIfcController {
	readonly #mapray: MaprayModule;
	readonly #viewer: MaprayViewerInstance;
	readonly #workerFactory: () => Worker;
	readonly #onProgress?: (message: string) => void;
	readonly #modelOffsetTilt: number;
	readonly #boundsEpsilon: number;
	readonly #wasmPath?: string;

	#ifcWorker: Worker | null = null;
	#nextRequestId = 1;
	#pendingRequest: PendingRequest | null = null;
	#sceneLoader: SceneLoaderInstance | null = null;
	#sceneAsset: SceneAsset | null = null;
	#loadedEntities: MaprayModelEntityInstance[] = [];
	#loadingEntities: MaprayModelEntityInstance[] = [];
	#chunkMetadata = new Map<MaprayModelEntityInstance, IfcElementMetadata[]>();
	#elements: IfcElementMetadata[] = [];
	#stats: ExtractedModelStats | null = null;
	#isLoading = false;
	#activeLoadId = 0;
	#transform: IfcModelTransform = {
		longitude: 0,
		latitude: 0,
		height: 0,
		heading: 0,
		tilt: 0,
		roll: 0,
		scale: 1
	};

	constructor(options: MaprayIfcControllerOptions) {
		this.#mapray = options.mapray;
		this.#viewer = options.viewer;
		this.#workerFactory =
			options.workerFactory ??
			(() =>
				new Worker(new URL('./ifc-worker.js', import.meta.url), {
					type: 'module'
				}));
		this.#onProgress = options.onProgress;
		this.#modelOffsetTilt = options.modelOffsetTilt ?? DEFAULT_MODEL_OFFSET_TILT;
		this.#boundsEpsilon = options.boundsEpsilon ?? DEFAULT_BOUNDS_EPSILON;
		this.#wasmPath = options.wasmPath;
	}

	get stats(): ExtractedModelStats | null {
		return this.#stats;
	}

	get elements(): readonly IfcElementMetadata[] {
		return this.#elements;
	}

	get loadedEntityCount(): number {
		return this.#loadedEntities.length;
	}

	get transform(): IfcModelTransform {
		return { ...this.#transform };
	}

	setTransform(nextTransform: Partial<IfcModelTransform>): void {
		this.#transform = {
			...this.#transform,
			...nextTransform
		};
		this.#applyTransform();
	}

	getCurrentOriginGocs(): Vector3 | null {
		const origin = new this.#mapray.GeoPoint(
			this.#transform.longitude,
			this.#transform.latitude,
			this.#transform.height
		).getAsGocs(this.#mapray.GeoMath.createVector3());

		return [origin[0], origin[1], origin[2]];
	}

	moveToGocsPosition(position: Vector3): void {
		const geoPoint = new this.#mapray.GeoPoint().setFromGocs(position);
		this.setTransform({
			longitude: geoPoint.longitude,
			latitude: geoPoint.latitude,
			height: geoPoint.altitude
		});
	}

	pickModelEntity(screenPosition: [number, number]): MaprayModelEntityInstance | null {
		const pickResult = this.#viewer.pick(screenPosition);

		return pickResult?.entity instanceof this.#mapray.ModelEntity ? pickResult.entity : null;
	}

	pick(screenPosition: [number, number]): MaprayIfcPickResult {
		if (this.#loadedEntities.length === 0) {
			return {
				element: null,
				entity: null,
				worldPosition: null,
				elapsedMs: 0
			};
		}

		const startedAt = performance.now();
		const pickResult = this.#viewer.pick(screenPosition);
		const elapsedMs = performance.now() - startedAt;

		if (!(pickResult?.entity instanceof this.#mapray.ModelEntity)) {
			return {
				element: null,
				entity: null,
				worldPosition: null,
				elapsedMs
			};
		}

		const candidates = this.#chunkMetadata.get(pickResult.entity) ?? [];
		const localPoint = this.#toModelLocalPosition([
			pickResult.position[0],
			pickResult.position[1],
			pickResult.position[2]
		]);

		return {
			element: localPoint ? this.#resolvePickedElement(candidates, localPoint) : null,
			entity: pickResult.entity,
			worldPosition: [pickResult.position[0], pickResult.position[1], pickResult.position[2]],
			elapsedMs
		};
	}

	async load(
		source: File | Blob | ArrayBuffer,
		options: MaprayIfcLoadOptions = {}
	): Promise<MaprayIfcLoadResult> {
		if (this.#isLoading) {
			throw new Error('Another IFC file is already being loaded.');
		}

		const loadId = ++this.#activeLoadId;
		this.#isLoading = true;
		const totalLoadStartedAt = performance.now();
		let nextSceneAsset: SceneAsset | null = null;
		const nextLoadedEntities: MaprayModelEntityInstance[] = [];
		let nextChunkMetadata = new Map<MaprayModelEntityInstance, IfcElementMetadata[]>();

		try {
			const { data, fileSizeBytes } = await this.#toArrayBuffer(source, options.fileSizeBytes);
			const workerResult = await this.#processIfcInWorker(data, this.#wasmPath);
			this.#assertActiveLoad(loadId);

			nextSceneAsset = createSceneAsset(workerResult.scenePackage);
			nextChunkMetadata = new Map<MaprayModelEntityInstance, IfcElementMetadata[]>();
			const metadataByExpressId = new Map(
				workerResult.elements.map((element) => [element.expressID, element] as const)
			);
			const chunkByEntityId = new Map(
				workerResult.chunks.map((chunk) => [chunk.entityId, chunk] as const)
			);

			this.#clearLoadedScene();
			this.#sceneAsset = nextSceneAsset;
			this.#loadingEntities = nextLoadedEntities;

			const maprayLoadStartedAt = performance.now();
			this.#sceneLoader = new this.#mapray.SceneLoader(
				this.#viewer.scene,
				createMemoryResource(this.#mapray, this.#sceneAsset),
				{
					onEntity: (loader, entity, item) => {
						loader.scene.addEntity(entity);

						if (!(entity instanceof this.#mapray.ModelEntity)) {
							return;
						}

						const entityId =
							typeof item === 'object' &&
							item !== null &&
							'id' in item &&
							typeof (item as { id?: unknown }).id === 'string'
								? (item as { id: string }).id
								: null;

						if (!entityId) {
							return;
						}

						const chunk = chunkByEntityId.get(entityId);

						if (!chunk) {
							return;
						}

						nextLoadedEntities.push(entity);
						nextChunkMetadata.set(
							entity,
							chunk.elementExpressIds
								.map((expressID) => metadataByExpressId.get(expressID))
								.filter((element): element is IfcElementMetadata => element !== undefined)
						);
					}
				}
			);
			await this.#sceneLoader.load();
			this.#assertActiveLoad(loadId);
			const maprayLoadMs = performance.now() - maprayLoadStartedAt;

			if (nextLoadedEntities.length === 0) {
				throw new Error('Mapray model entities could not be created.');
			}

			this.#sceneLoader = null;
			this.#loadingEntities = [];
			this.#loadedEntities = nextLoadedEntities;
			this.#chunkMetadata = nextChunkMetadata;
			this.#elements = workerResult.elements;
			this.#stats = workerResult.stats;
			this.#applyTransform();

			return {
				stats: workerResult.stats,
				elements: workerResult.elements,
				metrics: workerResult.metrics,
				maprayLoadMs,
				totalLoadMs: performance.now() - totalLoadStartedAt,
				loadedEntityCount: nextLoadedEntities.length,
				chunkCount: workerResult.chunks.length,
				sceneResourceCount: Object.keys(nextSceneAsset.resources).length,
				sceneBinaryBytes: getBinaryResourceBytes(nextSceneAsset),
				fileSizeBytes
			};
		} catch (error) {
			this.#removeEntities(nextLoadedEntities);
			this.#loadingEntities = [];
			this.#sceneLoader = null;

			if (nextSceneAsset && this.#sceneAsset === nextSceneAsset) {
				nextSceneAsset.revoke();
				this.#sceneAsset = null;
			}

			throw error;
		} finally {
			if (loadId === this.#activeLoadId) {
				this.#isLoading = false;
			}
		}
	}

	unload(): void {
		this.#cancelInFlightLoad();
		this.#clearLoadedScene();
	}

	destroy(): void {
		this.#cancelInFlightLoad();
		this.#clearLoadedScene();
		this.#ifcWorker?.terminate();
		this.#ifcWorker = null;
	}

	async #toArrayBuffer(
		source: File | Blob | ArrayBuffer,
		fileSizeBytes?: number
	): Promise<{ data: ArrayBuffer; fileSizeBytes: number | null }> {
		if (source instanceof ArrayBuffer) {
			return {
				data: source,
				fileSizeBytes: fileSizeBytes ?? source.byteLength
			};
		}

		return {
			data: await source.arrayBuffer(),
			fileSizeBytes: fileSizeBytes ?? source.size
		};
	}

	#ensureIfcWorker(): Worker {
		if (!this.#ifcWorker) {
			this.#ifcWorker = this.#workerFactory();
			this.#ifcWorker.addEventListener('message', this.#handleWorkerMessage);
			this.#ifcWorker.addEventListener('error', (event) => {
				this.#resetIfcWorker();

				if (!this.#pendingRequest) {
					return;
				}

				const { reject } = this.#pendingRequest;
				this.#pendingRequest = null;
				const location =
					event.filename && event.lineno
						? ` (${event.filename}:${event.lineno}${event.colno ? `:${event.colno}` : ''})`
						: '';
				reject(new Error(`${event.message || 'IFC worker failed.'}${location}`));
			});
		}

		return this.#ifcWorker;
	}

	#handleWorkerMessage = (event: MessageEvent<IfcWorkerResponse>): void => {
		const message = event.data;

		if (!this.#pendingRequest || message.requestId !== this.#pendingRequest.requestId) {
			return;
		}

		if (message.type === 'progress') {
			this.#onProgress?.(message.message);
			return;
		}

		if (message.type === 'error') {
			const { reject } = this.#pendingRequest;
			this.#pendingRequest = null;
			reject(new Error(message.error));
			return;
		}

		const { resolve } = this.#pendingRequest;
		this.#pendingRequest = null;
		resolve(message);
	};

	async #processIfcInWorker(
		data: ArrayBuffer,
		wasmPath?: string
	): Promise<IfcWorkerSuccessMessage> {
		if (this.#pendingRequest) {
			throw new Error('Another IFC file is already being processed.');
		}

		const worker = this.#ensureIfcWorker();
		const requestId = this.#nextRequestId;
		this.#nextRequestId += 1;

		return await new Promise<IfcWorkerSuccessMessage>((resolve, reject) => {
			this.#pendingRequest = { requestId, resolve, reject };
			worker.postMessage(
				{
					type: 'load-ifc',
					requestId,
					data,
					wasmPath
				},
				[data]
			);
		});
	}

	#assertActiveLoad(loadId: number): void {
		if (loadId !== this.#activeLoadId) {
			throw new Error('IFC loading was canceled.');
		}
	}

	#cancelInFlightLoad(): void {
		if (!this.#isLoading && !this.#pendingRequest && this.#loadingEntities.length === 0) {
			return;
		}

		this.#activeLoadId += 1;
		this.#isLoading = false;

		if (this.#pendingRequest) {
			const { reject } = this.#pendingRequest;
			this.#pendingRequest = null;
			reject(new Error('IFC loading was canceled.'));
			this.#resetIfcWorker();
		}

		this.#sceneLoader?.cancel();
		this.#sceneLoader = null;
		this.#removeEntities(this.#loadingEntities);
		this.#loadingEntities = [];
	}

	#resetIfcWorker(): void {
		this.#ifcWorker?.terminate();
		this.#ifcWorker = null;
	}

	#clearLoadedScene(): void {
		this.#removeEntities(this.#loadedEntities);
		this.#loadedEntities = [];
		this.#chunkMetadata = new Map<MaprayModelEntityInstance, IfcElementMetadata[]>();
		this.#elements = [];
		this.#stats = null;
		this.#sceneAsset?.revoke();
		this.#sceneAsset = null;
	}

	#removeEntities(entities: MaprayModelEntityInstance[]): void {
		for (const entity of entities) {
			this.#viewer.scene.removeEntity(entity);
		}
	}

	#applyTransform(): void {
		if (this.#loadedEntities.length === 0) {
			return;
		}

		const position = new this.#mapray.GeoPoint(
			this.#transform.longitude,
			this.#transform.latitude,
			this.#transform.height
		);
		const orientation = new this.#mapray.Orientation(
			this.#transform.heading,
			this.#transform.tilt,
			this.#transform.roll
		);

		for (const entity of this.#loadedEntities) {
			entity.setPosition(position);
			entity.setOrientation(orientation);
			entity.setScale([this.#transform.scale, this.#transform.scale, this.#transform.scale]);
			entity.altitude_mode = this.#mapray.AltitudeMode.ABSOLUTE;
		}
	}

	#getModelToGocsMatrix() {
		const geoMath = this.#mapray.GeoMath;
		const mlocsToGocs = new this.#mapray.GeoPoint(
			this.#transform.longitude,
			this.#transform.latitude,
			this.#transform.height
		).getMlocsToGocsMatrix(geoMath.createMatrix());
		const entityToMlocs = new this.#mapray.Orientation(
			this.#transform.heading,
			this.#transform.tilt,
			this.#transform.roll
		).getTransformMatrix(
			[this.#transform.scale, this.#transform.scale, this.#transform.scale],
			geoMath.createMatrix()
		);
		const offsetToEntity = new this.#mapray.Orientation(
			0,
			this.#modelOffsetTilt,
			0
		).getTransformMatrix([1, 1, 1], geoMath.createMatrix());
		const modelToMlocs = geoMath.mul_AA(entityToMlocs, offsetToEntity, geoMath.createMatrix());

		return geoMath.mul_AA(mlocsToGocs, modelToMlocs, geoMath.createMatrix());
	}

	#toModelLocalPosition(position: Vector3): Vector3 | null {
		const geoMath = this.#mapray.GeoMath;
		const modelToGocs = this.#getModelToGocsMatrix();
		const gocsToModel = geoMath.inverse_A(modelToGocs, geoMath.createMatrix());
		const localPosition = geoMath.transformPosition_A(
			gocsToModel,
			position,
			geoMath.createVector3()
		);

		return [localPosition[0], localPosition[1], localPosition[2]];
	}

	#resolvePickedElement(
		candidates: IfcElementMetadata[],
		localPoint: Vector3
	): IfcElementMetadata | null {
		const withBounds = candidates.filter(
			(element): element is IfcElementMetadata & { bounds: IfcElementBounds } =>
				element.bounds !== null
		);

		if (withBounds.length === 0) {
			return null;
		}

		const containing = withBounds.filter((element) =>
			isPointInsideBounds(localPoint, element.bounds, this.#boundsEpsilon)
		);

		if (containing.length > 0) {
			containing.sort((a, b) => {
				if (a.bounds.volume !== b.bounds.volume) {
					return a.bounds.volume - b.bounds.volume;
				}

				return (
					getCenterDistanceSquared(localPoint, a.bounds) -
					getCenterDistanceSquared(localPoint, b.bounds)
				);
			});

			return containing[0];
		}

		let nearest: (IfcElementMetadata & { bounds: IfcElementBounds }) | null = null;
		let nearestDistance = Number.POSITIVE_INFINITY;

		for (const element of withBounds) {
			const distance = getBoundsDistanceSquared(localPoint, element.bounds);

			if (distance < nearestDistance) {
				nearest = element;
				nearestDistance = distance;
			}
		}

		return nearest;
	}
}
