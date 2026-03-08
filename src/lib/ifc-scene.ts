import type { SceneChunk, ScenePackage } from './gltf-builder';
import type { IfcElementMetadata } from './ifc-loader';
import { createMemoryResource } from './memory-resource';

type MaprayModule = typeof import('@mapray/mapray-js').default;
type MaprayViewerInstance = InstanceType<MaprayModule['Viewer']>;
type MaprayModelEntityInstance = InstanceType<MaprayModule['ModelEntity']>;
type SceneLoaderInstance = InstanceType<MaprayModule['SceneLoader']>;

export type SceneAsset = ScenePackage & { revoke(): void };

export interface SceneLoadSession {
	sceneLoader: SceneLoaderInstance;
	loadedEntities: MaprayModelEntityInstance[];
	chunkMetadata: Map<MaprayModelEntityInstance, IfcElementMetadata[]>;
}

function getEntityIdFromSceneItem(item: unknown): string | null {
	return typeof item === 'object' &&
		item !== null &&
		'id' in item &&
		typeof (item as { id?: unknown }).id === 'string'
		? (item as { id: string }).id
		: null;
}

function createChunkMetadataIndexes(
	elements: IfcElementMetadata[],
	chunks: SceneChunk[]
): {
	metadataByExpressId: Map<number, IfcElementMetadata>;
	chunkByEntityId: Map<string, SceneChunk>;
} {
	return {
		metadataByExpressId: new Map(elements.map((element) => [element.expressID, element] as const)),
		chunkByEntityId: new Map(chunks.map((chunk) => [chunk.entityId, chunk] as const))
	};
}

export function getBinaryResourceBytes(scenePackage: ScenePackage): number {
	return Object.values(scenePackage.resources).reduce((total, resource) => {
		return total + (resource.binary?.byteLength ?? 0);
	}, 0);
}

export function createSceneAsset(scenePackage: ScenePackage): SceneAsset {
	return {
		...scenePackage,
		revoke() {}
	};
}

export function removeEntities(
	viewer: MaprayViewerInstance,
	entities: MaprayModelEntityInstance[]
): void {
	for (const entity of entities) {
		viewer.scene.removeEntity(entity);
	}
}

export function startSceneLoad(options: {
	mapray: MaprayModule;
	viewer: MaprayViewerInstance;
	sceneAsset: SceneAsset;
	elements: IfcElementMetadata[];
	chunks: SceneChunk[];
}): SceneLoadSession {
	const { metadataByExpressId, chunkByEntityId } = createChunkMetadataIndexes(
		options.elements,
		options.chunks
	);
	const loadedEntities: MaprayModelEntityInstance[] = [];
	const chunkMetadata = new Map<MaprayModelEntityInstance, IfcElementMetadata[]>();

	const sceneLoader = new options.mapray.SceneLoader(
		options.viewer.scene,
		createMemoryResource(options.mapray, options.sceneAsset),
		{
			onEntity: (loader, entity, item) => {
				loader.scene.addEntity(entity);

				if (!(entity instanceof options.mapray.ModelEntity)) {
					return;
				}

				const entityId = getEntityIdFromSceneItem(item);

				if (!entityId) {
					return;
				}

				const chunk = chunkByEntityId.get(entityId);

				if (!chunk) {
					return;
				}

				loadedEntities.push(entity);
				chunkMetadata.set(
					entity,
					chunk.elementExpressIds
						.map((expressID) => metadataByExpressId.get(expressID))
						.filter((element): element is IfcElementMetadata => element !== undefined)
				);
			}
		}
	);

	return {
		sceneLoader,
		loadedEntities,
		chunkMetadata
	};
}
