import { IfcAPI } from 'web-ifc';
import webIfcWasmUrl from 'web-ifc/web-ifc.wasm?url';

export interface ExtractedMesh {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
	color: { r: number; g: number; b: number; a: number };
}

export interface IfcElementBounds {
	min: [number, number, number];
	max: [number, number, number];
	center: [number, number, number];
	size: [number, number, number];
	volume: number;
}

export interface IfcElementMetadata {
	expressID: number;
	entityId: string;
	type: string;
	globalId: string | null;
	name: string | null;
	description: string | null;
	objectType: string | null;
	tag: string | null;
	predefinedType: string | null;
	bounds: IfcElementBounds | null;
}

export interface ExtractedElement {
	expressID: number;
	entityId: string;
	meshes: ExtractedMesh[];
	metadata: IfcElementMetadata;
	bounds: IfcElementBounds | null;
}

export interface ExtractedModelStats {
	elementCount: number;
	meshCount: number;
	vertexCount: number;
	triangleCount: number;
	bounds: {
		min: [number, number, number];
		max: [number, number, number];
		size: [number, number, number];
		radius: number;
	};
}

export interface ExtractedModel {
	elements: ExtractedElement[];
	stats: ExtractedModelStats;
}

let ifcApi: IfcAPI | null = null;
let ifcApiWasmUrl: string | null = null;

const DEFAULT_WASM_URL = new URL(webIfcWasmUrl, import.meta.url).toString();

function safeDelete(value: unknown): void {
	if (
		value &&
		typeof value === 'object' &&
		'delete' in value &&
		typeof (value as { delete?: unknown }).delete === 'function'
	) {
		(value as { delete: () => void }).delete();
	}
}

export function resolveWasmUrl(wasmPath: string, baseHref: string): string {
	const resolved = new URL(wasmPath, baseHref);

	if (resolved.pathname.endsWith('.wasm')) {
		return resolved.toString();
	}

	const directoryUrl = resolved.toString().endsWith('/') ? resolved.toString() : `${resolved.toString()}/`;
	return new URL('web-ifc.wasm', directoryUrl).toString();
}

async function getIfcApi(wasmPath = DEFAULT_WASM_URL): Promise<IfcAPI> {
	const resolvedWasmUrl = resolveWasmUrl(wasmPath, self.location.href);

	if (ifcApi && ifcApiWasmUrl === resolvedWasmUrl) {
		return ifcApi;
	}

	if (ifcApi) {
		ifcApi.Dispose();
		ifcApi = null;
		ifcApiWasmUrl = null;
	}

	const api = new IfcAPI();
	await api.Init(() => resolvedWasmUrl, true);
	ifcApi = api;
	ifcApiWasmUrl = resolvedWasmUrl;

	return api;
}

function applyTransform(
	x: number,
	y: number,
	z: number,
	matrix: number[]
): [number, number, number] {
	return [
		matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
		matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
		matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
	];
}

function applyTransformNormal(
	nx: number,
	ny: number,
	nz: number,
	matrix: number[]
): [number, number, number] {
	const tx = matrix[0] * nx + matrix[4] * ny + matrix[8] * nz;
	const ty = matrix[1] * nx + matrix[5] * ny + matrix[9] * nz;
	const tz = matrix[2] * nx + matrix[6] * ny + matrix[10] * nz;
	const length = Math.hypot(tx, ty, tz);

	if (length === 0) {
		return [0, 0, 1];
	}

	return [tx / length, ty / length, tz / length];
}

function toOptionalDisplayValue(value: unknown): string | null {
	if (value === null || value === undefined || value === '') {
		return null;
	}

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	if (typeof value === 'object' && 'value' in value) {
		return toOptionalDisplayValue((value as { value: unknown }).value);
	}

	return JSON.stringify(value);
}

async function extractElementMetadata(
	api: IfcAPI,
	modelID: number,
	expressID: number,
	bounds: IfcElementBounds | null = null
): Promise<IfcElementMetadata> {
	const item = api.GetLine(modelID, expressID, false, false) as Record<string, unknown>;
	const typeCode = api.GetLineType(modelID, expressID);

	return {
		expressID,
		entityId: `ifc-element-${expressID}`,
		type: api.GetNameFromTypeCode(typeCode),
		globalId: toOptionalDisplayValue(item.GlobalId),
		name: toOptionalDisplayValue(item.Name),
		description: toOptionalDisplayValue(item.Description),
		objectType: toOptionalDisplayValue(item.ObjectType),
		tag: toOptionalDisplayValue(item.Tag),
		predefinedType: toOptionalDisplayValue(item.PredefinedType),
		bounds
	};
}

export async function extractGeometry(
	data: Uint8Array,
	wasmPath?: string
): Promise<ExtractedModel> {
	const api = await getIfcApi(wasmPath);
	const modelID = api.OpenModel(data, {
		COORDINATE_TO_ORIGIN: true,
		CIRCLE_SEGMENTS: 12,
		TOLERANCE_PLANE_INTERSECTION: 1e-5,
		TOLERANCE_PLANE_DEVIATION: 1e-5,
		TOLERANCE_BACK_DEVIATION_DISTANCE: 1e-5,
		TOLERANCE_INSIDE_OUTSIDE_PERIMETER: 1e-5,
		TOLERANCE_SCALAR_EQUALITY: 1e-5,
		PLANE_REFIT_ITERATIONS: 20
	});

	const elements = new Map<number, ExtractedElement>();
	let vertexCount = 0;
	let triangleCount = 0;
	let meshCount = 0;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;

	try {
		const flatMeshes = api.LoadAllGeometry(modelID);

		for (let i = 0; i < flatMeshes.size(); i += 1) {
			const flatMesh = flatMeshes.get(i);
			const geometries = flatMesh.geometries;
			let element = elements.get(flatMesh.expressID);

			if (!element) {
				element = {
					expressID: flatMesh.expressID,
					entityId: `ifc-element-${flatMesh.expressID}`,
					meshes: [],
					metadata: await extractElementMetadata(api, modelID, flatMesh.expressID),
					bounds: null
				};
				elements.set(flatMesh.expressID, element);
			}

			for (let j = 0; j < geometries.size(); j += 1) {
				const placedGeometry = geometries.get(j);
				const geometry = api.GetGeometry(modelID, placedGeometry.geometryExpressID);

				try {
					const vertexData = api.GetVertexArray(
						geometry.GetVertexData(),
						geometry.GetVertexDataSize()
					);
					const indexData = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());

					if (vertexData.length === 0 || indexData.length === 0) {
						continue;
					}

					const transform = placedGeometry.flatTransformation;
					const transformedVertexCount = vertexData.length / 6;
					const positions = new Float32Array(transformedVertexCount * 3);
					const normals = new Float32Array(transformedVertexCount * 3);
					let elementMinX = element.bounds?.min[0] ?? Number.POSITIVE_INFINITY;
					let elementMinY = element.bounds?.min[1] ?? Number.POSITIVE_INFINITY;
					let elementMinZ = element.bounds?.min[2] ?? Number.POSITIVE_INFINITY;
					let elementMaxX = element.bounds?.max[0] ?? Number.NEGATIVE_INFINITY;
					let elementMaxY = element.bounds?.max[1] ?? Number.NEGATIVE_INFINITY;
					let elementMaxZ = element.bounds?.max[2] ?? Number.NEGATIVE_INFINITY;

					for (let v = 0; v < transformedVertexCount; v += 1) {
						const sourceOffset = v * 6;
						const targetOffset = v * 3;

						const [x, y, z] = applyTransform(
							vertexData[sourceOffset],
							vertexData[sourceOffset + 1],
							vertexData[sourceOffset + 2],
							transform
						);
						positions[targetOffset] = x;
						positions[targetOffset + 1] = y;
						positions[targetOffset + 2] = z;

						minX = Math.min(minX, x);
						minY = Math.min(minY, y);
						minZ = Math.min(minZ, z);
						maxX = Math.max(maxX, x);
						maxY = Math.max(maxY, y);
						maxZ = Math.max(maxZ, z);
						elementMinX = Math.min(elementMinX, x);
						elementMinY = Math.min(elementMinY, y);
						elementMinZ = Math.min(elementMinZ, z);
						elementMaxX = Math.max(elementMaxX, x);
						elementMaxY = Math.max(elementMaxY, y);
						elementMaxZ = Math.max(elementMaxZ, z);

						const [nx, ny, nz] = applyTransformNormal(
							vertexData[sourceOffset + 3],
							vertexData[sourceOffset + 4],
							vertexData[sourceOffset + 5],
							transform
						);
						normals[targetOffset] = nx;
						normals[targetOffset + 1] = ny;
						normals[targetOffset + 2] = nz;
					}

					element.meshes.push({
						positions,
						normals,
						indices: new Uint32Array(indexData),
						color: {
							r: placedGeometry.color.x,
							g: placedGeometry.color.y,
							b: placedGeometry.color.z,
							a: placedGeometry.color.w
						}
					});
					const sizeX = elementMaxX - elementMinX;
					const sizeY = elementMaxY - elementMinY;
					const sizeZ = elementMaxZ - elementMinZ;
					element.bounds = {
						min: [elementMinX, elementMinY, elementMinZ],
						max: [elementMaxX, elementMaxY, elementMaxZ],
						center: [
							(elementMinX + elementMaxX) / 2,
							(elementMinY + elementMaxY) / 2,
							(elementMinZ + elementMaxZ) / 2
						],
						size: [sizeX, sizeY, sizeZ],
						volume: sizeX * sizeY * sizeZ
					};
					element.metadata.bounds = element.bounds;

					meshCount += 1;
					vertexCount += transformedVertexCount;
					triangleCount += indexData.length / 3;
				} finally {
					safeDelete(geometry);
				}
			}

			safeDelete(flatMesh);
		}
	} finally {
		api.CloseModel(modelID);
	}

	const extractedElements = Array.from(elements.values()).filter(
		(element) => element.meshes.length > 0
	);

	if (extractedElements.length === 0) {
		throw new Error('IFC geometry was not found.');
	}

	const sizeX = maxX - minX;
	const sizeY = maxY - minY;
	const sizeZ = maxZ - minZ;

	return {
		elements: extractedElements,
		stats: {
			elementCount: extractedElements.length,
			meshCount,
			vertexCount,
			triangleCount,
			bounds: {
				min: [minX, minY, minZ],
				max: [maxX, maxY, maxZ],
				size: [sizeX, sizeY, sizeZ],
				radius: Math.max(sizeX, sizeY, sizeZ) / 2
			}
		}
	};
}
