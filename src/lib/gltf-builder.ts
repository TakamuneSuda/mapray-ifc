import {
	Accessor,
	Document,
	Material,
	Primitive,
	WebIO,
	type JSONDocument
} from '@gltf-transform/core';
import type { ExtractedMesh, ExtractedModel } from './ifc-loader';

export interface MemoryResourceEntry {
	json?: Record<string, unknown>;
	binary?: ArrayBuffer;
}

export interface ScenePackage {
	entryPath: string;
	resources: Record<string, MemoryResourceEntry>;
}

export interface SceneChunk {
	entityId: string;
	elementExpressIds: number[];
}

type MeshColor = ExtractedMesh['color'];
const OFFSET_TILT_DEGREES = -90;
const DEFAULT_CHUNK_SIZE = 64;

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function getColorKey(color: MeshColor): string {
	return [color.r, color.g, color.b, color.a].map((value) => value.toFixed(6)).join(':');
}

function toArrayBuffer(view: Uint8Array<ArrayBuffer>): ArrayBuffer {
	return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function toFloat32Array(view: Float32Array): Float32Array<ArrayBuffer> {
	return new Float32Array(view);
}

function toUint32Array(view: Uint32Array): Uint32Array<ArrayBuffer> {
	return new Uint32Array(view);
}

function createMaterial(doc: Document, name: string, color: MeshColor): Material {
	const alpha = clamp01(color.a);

	return doc
		.createMaterial(name)
		.setBaseColorFactor([clamp01(color.r), clamp01(color.g), clamp01(color.b), alpha])
		.setMetallicFactor(0)
		.setRoughnessFactor(1)
		.setDoubleSided(true)
		.setAlphaMode(alpha < 1 ? Material.AlphaMode.BLEND : Material.AlphaMode.OPAQUE);
}

function mergeMeshes(meshes: ExtractedMesh[]): ExtractedMesh {
	const totalPositionCount = meshes.reduce((count, mesh) => count + mesh.positions.length, 0);
	const totalNormalCount = meshes.reduce((count, mesh) => count + mesh.normals.length, 0);
	const totalIndexCount = meshes.reduce((count, mesh) => count + mesh.indices.length, 0);
	const positions = new Float32Array(totalPositionCount);
	const normals = new Float32Array(totalNormalCount);
	const indices = new Uint32Array(totalIndexCount);
	let positionOffset = 0;
	let normalOffset = 0;
	let indexOffset = 0;
	let vertexOffset = 0;

	for (const mesh of meshes) {
		positions.set(mesh.positions, positionOffset);
		normals.set(mesh.normals, normalOffset);

		for (let i = 0; i < mesh.indices.length; i += 1) {
			indices[indexOffset + i] = mesh.indices[i] + vertexOffset;
		}

		positionOffset += mesh.positions.length;
		normalOffset += mesh.normals.length;
		indexOffset += mesh.indices.length;
		vertexOffset += mesh.positions.length / 3;
	}

	return {
		positions,
		normals,
		indices,
		color: meshes[0].color
	};
}

function mergeElementMeshesByColor(meshes: ExtractedMesh[]): ExtractedMesh[] {
	const groups = new Map<string, ExtractedMesh[]>();

	for (const mesh of meshes) {
		const colorKey = getColorKey(mesh.color);
		const group = groups.get(colorKey);

		if (group) {
			group.push(mesh);
		} else {
			groups.set(colorKey, [mesh]);
		}
	}

	return Array.from(groups.values(), (group) =>
		group.length === 1 ? group[0] : mergeMeshes(group)
	);
}

function toMemoryResourceMap(jsonDocument: JSONDocument): Record<string, MemoryResourceEntry> {
	const resources: Record<string, MemoryResourceEntry> = {};

	for (const [key, value] of Object.entries(jsonDocument.resources)) {
		resources[key] = {
			binary: toArrayBuffer(value)
		};
	}

	return resources;
}

function createGltfResources(
	resourceDir: string,
	jsonDocument: JSONDocument
): Record<string, MemoryResourceEntry> {
	const resources = toMemoryResourceMap(jsonDocument);
	const prefixedResources: Record<string, MemoryResourceEntry> = {};

	for (const [key, value] of Object.entries(resources)) {
		prefixedResources[`${resourceDir}/${key}`] = value;
	}

	return prefixedResources;
}

function chunkElements(
	elements: ExtractedModel['elements'],
	chunkSize = DEFAULT_CHUNK_SIZE
): ExtractedModel['elements'][] {
	const chunks: ExtractedModel['elements'][] = [];

	for (let i = 0; i < elements.length; i += chunkSize) {
		chunks.push(elements.slice(i, i + chunkSize));
	}

	return chunks;
}

async function createChunkModelResources(
	elements: ExtractedModel['elements'],
	chunkIndex: number
): Promise<{
	modelId: string;
	entityId: string;
	elementExpressIds: number[];
	linkPath: string;
	resources: Record<string, MemoryResourceEntry>;
}> {
	const doc = new Document();
	const chunkId = `ifc-chunk-${chunkIndex}`;
	const buffer = doc.createBuffer(`${chunkId}-buffer`);
	const scene = doc.createScene(`${chunkId}-scene`);
	const node = doc.createNode(`${chunkId}-node`);
	const mesh = doc.createMesh(`${chunkId}-mesh`);
	const materials = new Map<string, Material>();

	scene.addChild(node);
	node.setMesh(mesh);

	for (const element of elements) {
		const mergedMeshes = mergeElementMeshesByColor(element.meshes);

		for (let i = 0; i < mergedMeshes.length; i += 1) {
			const sourceMesh = mergedMeshes[i];
			const positionAccessor = doc
				.createAccessor(`positions-${element.expressID}-${i}`, buffer)
				.setType(Accessor.Type.VEC3)
				.setArray(toFloat32Array(sourceMesh.positions));
			const normalAccessor = doc
				.createAccessor(`normals-${element.expressID}-${i}`, buffer)
				.setType(Accessor.Type.VEC3)
				.setArray(toFloat32Array(sourceMesh.normals));
			const indexAccessor = doc
				.createAccessor(`indices-${element.expressID}-${i}`, buffer)
				.setType(Accessor.Type.SCALAR)
				.setArray(toUint32Array(sourceMesh.indices));
			const materialKey = getColorKey(sourceMesh.color);
			let material = materials.get(materialKey);

			if (!material) {
				material = createMaterial(doc, `material-${materialKey}`, sourceMesh.color);
				materials.set(materialKey, material);
			}

			const primitive = doc
				.createPrimitive()
				.setMode(Primitive.Mode.TRIANGLES)
				.setAttribute('POSITION', positionAccessor)
				.setAttribute('NORMAL', normalAccessor)
				.setIndices(indexAccessor)
				.setMaterial(material);

			mesh.addPrimitive(primitive);
		}
	}

	const io = new WebIO();
	const jsonDocument = await io.writeJSON(doc, { basename: 'model' });
	const resourceDir = `models/${chunkId}`;

	return {
		modelId: `${chunkId}-model`,
		entityId: chunkId,
		elementExpressIds: elements.map((element) => element.expressID),
		linkPath: `${resourceDir}/model.gltf`,
		resources: {
			[`${resourceDir}/model.gltf`]: {
				json: jsonDocument.json as unknown as Record<string, unknown>
			},
			...createGltfResources(resourceDir, jsonDocument)
		}
	};
}

export async function createIfcScenePackage(model: ExtractedModel): Promise<{
	scenePackage: ScenePackage;
	chunks: SceneChunk[];
}> {
	const elementChunks = chunkElements(model.elements);
	const modelResources = await Promise.all(
		elementChunks.map((elements, index) => createChunkModelResources(elements, index))
	);
	const sceneJson = {
		model_register: Object.fromEntries(
			modelResources.map((resource) => [
				resource.modelId,
				{
					link: resource.linkPath,
					offset_transform: {
						tilt: OFFSET_TILT_DEGREES
					}
				}
			])
		),
		entity_list: modelResources.map((resource) => ({
			id: resource.entityId,
			type: 'model',
			mode: 'basic',
			transform: {
				position: [0, 0, 0],
				heading: 0,
				tilt: 0,
				roll: 0,
				scale: 1
			},
			ref_model: resource.modelId,
			altitude_mode: 'absolute'
		}))
	};
	const resources: Record<string, MemoryResourceEntry> = {
		'scene.json': { json: sceneJson }
	};

	for (const resource of modelResources) {
		for (const [path, entry] of Object.entries(resource.resources)) {
			resources[path] = entry;
		}
	}

	return {
		scenePackage: {
			entryPath: 'scene.json',
			resources
		},
		chunks: modelResources.map((resource) => ({
			entityId: resource.entityId,
			elementExpressIds: resource.elementExpressIds
		}))
	};
}
