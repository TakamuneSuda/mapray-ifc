import type { IfcElementMetadata, ExtractedModelStats } from './ifc-loader';
import type { IfcProcessingMetrics } from './ifc-worker-types';
import { resolvePickedElement } from './ifc-pick';
import {
	createSceneAsset,
	getBinaryResourceBytes,
	removeEntities,
	startSceneLoad,
	type SceneAsset
} from './ifc-scene';
import {
	applyTransformToEntities,
	getCurrentOriginGocs,
	getTransformFromGocsPosition,
	toModelLocalPosition
} from './ifc-transform';
import { createIfcWorkerClient, type IfcWorkerClient } from './ifc-worker-client';

type MaprayModule = typeof import('@mapray/mapray-js').default;
type MaprayViewerInstance = InstanceType<MaprayModule['Viewer']>;
type MaprayModelEntityInstance = InstanceType<MaprayModule['ModelEntity']>;
type SceneLoaderInstance = InstanceType<MaprayModule['SceneLoader']>;
type Vector3 = [number, number, number];

const DEFAULT_MODEL_OFFSET_TILT = -90;
const DEFAULT_BOUNDS_EPSILON = 0.05;

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

export class MaprayIfcController {
	readonly #mapray: MaprayModule;
	readonly #viewer: MaprayViewerInstance;
	readonly #workerClient: IfcWorkerClient;
	readonly #modelOffsetTilt: number;
	readonly #boundsEpsilon: number;
	readonly #wasmPath?: string;

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
		this.#workerClient = createIfcWorkerClient({
			workerFactory:
				options.workerFactory ??
				(() =>
					new Worker(new URL('./ifc-worker.js', import.meta.url), {
						type: 'module'
					})),
			onProgress: options.onProgress
		});
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
		return getCurrentOriginGocs(this.#mapray, this.#transform);
	}

	moveToGocsPosition(position: Vector3): void {
		this.setTransform(getTransformFromGocsPosition(this.#mapray, position));
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
		const localPoint = toModelLocalPosition(this.#mapray, this.#transform, this.#modelOffsetTilt, [
			pickResult.position[0],
			pickResult.position[1],
			pickResult.position[2]
		]);

		return {
			element: resolvePickedElement(candidates, localPoint, this.#boundsEpsilon),
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
		let nextLoadedEntities: MaprayModelEntityInstance[] = [];
		let nextChunkMetadata = new Map<MaprayModelEntityInstance, IfcElementMetadata[]>();

		try {
			const { data, fileSizeBytes } = await this.#toArrayBuffer(source, options.fileSizeBytes);
			const workerResult = await this.#workerClient.process(data, this.#wasmPath);
			this.#assertActiveLoad(loadId);

			nextSceneAsset = createSceneAsset(workerResult.scenePackage);
			this.#clearLoadedScene();
			this.#sceneAsset = nextSceneAsset;

			const maprayLoadStartedAt = performance.now();
			const sceneLoad = startSceneLoad({
				mapray: this.#mapray,
				viewer: this.#viewer,
				sceneAsset: this.#sceneAsset,
				elements: workerResult.elements,
				chunks: workerResult.chunks
			});
			nextLoadedEntities = sceneLoad.loadedEntities;
			nextChunkMetadata = sceneLoad.chunkMetadata;
			this.#sceneLoader = sceneLoad.sceneLoader;
			this.#loadingEntities = sceneLoad.loadedEntities;
			await this.#sceneLoader.load();
			this.#assertActiveLoad(loadId);
			const maprayLoadMs = performance.now() - maprayLoadStartedAt;

			if (sceneLoad.loadedEntities.length === 0) {
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
			removeEntities(this.#viewer, nextLoadedEntities);
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
		this.#workerClient.destroy();
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

	#assertActiveLoad(loadId: number): void {
		if (loadId !== this.#activeLoadId) {
			throw new Error('IFC loading was canceled.');
		}
	}

	#cancelInFlightLoad(): void {
		if (!this.#isLoading && this.#loadingEntities.length === 0) {
			return;
		}

		this.#activeLoadId += 1;
		this.#isLoading = false;

		this.#workerClient.cancel();

		this.#sceneLoader?.cancel();
		this.#sceneLoader = null;
		removeEntities(this.#viewer, this.#loadingEntities);
		this.#loadingEntities = [];
	}

	#clearLoadedScene(): void {
		removeEntities(this.#viewer, this.#loadedEntities);
		this.#loadedEntities = [];
		this.#chunkMetadata = new Map<MaprayModelEntityInstance, IfcElementMetadata[]>();
		this.#elements = [];
		this.#stats = null;
		this.#sceneAsset?.revoke();
		this.#sceneAsset = null;
	}

	#applyTransform(): void {
		applyTransformToEntities(this.#mapray, this.#loadedEntities, this.#transform);
	}
}
