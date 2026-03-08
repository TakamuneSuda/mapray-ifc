import { IfcAPI } from 'web-ifc';
import webIfcWasmUrl from 'web-ifc/web-ifc.wasm?url';

export interface ExtractedMesh {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
	color: { r: number; g: number; b: number; a: number };
}

export interface IfcPropertyValue {
	name: string;
	value: string;
}

export interface IfcPropertyGroup {
	name: string;
	properties: IfcPropertyValue[];
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
	propertyGroups: IfcPropertyGroup[];
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
let ifcApiWasmPath: string | null = null;

const DEFAULT_WASM_PATH = new URL('./', new URL(webIfcWasmUrl, import.meta.url)).toString();

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

function normalizeWasmPath(wasmPath: string): string {
	const resolved = new URL(wasmPath, self.location.href);

	if (resolved.pathname.endsWith('.wasm')) {
		return new URL('./', resolved).toString();
	}

	return resolved.toString().endsWith('/') ? resolved.toString() : `${resolved.toString()}/`;
}

async function getIfcApi(wasmPath = DEFAULT_WASM_PATH): Promise<IfcAPI> {
	const resolvedWasmPath = normalizeWasmPath(wasmPath);

	if (ifcApi && ifcApiWasmPath === resolvedWasmPath) {
		return ifcApi;
	}

	if (ifcApi) {
		ifcApi.Dispose();
		ifcApi = null;
		ifcApiWasmPath = null;
	}

	const api = new IfcAPI();
	api.SetWasmPath(resolvedWasmPath, true);
	await api.Init(undefined, true);
	ifcApi = api;
	ifcApiWasmPath = resolvedWasmPath;

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

function unwrapIfcValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return null;
	}

	if (Array.isArray(value)) {
		return value.map((entry) => unwrapIfcValue(entry));
	}

	if (typeof value !== 'object') {
		return value;
	}

	if ('value' in value) {
		return unwrapIfcValue((value as { value: unknown }).value);
	}

	const entries = Object.entries(value as Record<string, unknown>);

	if (entries.length === 1 && entries[0]?.[0] === 'expressID') {
		return entries[0][1];
	}

	const nextValue: Record<string, unknown> = {};

	for (const [key, entry] of entries) {
		if (key === 'type') {
			continue;
		}

		nextValue[key] = unwrapIfcValue(entry);
	}

	return nextValue;
}

function toDisplayValue(value: unknown): string {
	const normalized = unwrapIfcValue(value);

	if (normalized === null || normalized === undefined || normalized === '') {
		return '-';
	}

	if (
		typeof normalized === 'string' ||
		typeof normalized === 'number' ||
		typeof normalized === 'boolean'
	) {
		return String(normalized);
	}

	return JSON.stringify(normalized);
}

function toOptionalDisplayValue(value: unknown): string | null {
	const normalized = unwrapIfcValue(value);

	if (normalized === null || normalized === undefined || normalized === '') {
		return null;
	}

	if (
		typeof normalized === 'string' ||
		typeof normalized === 'number' ||
		typeof normalized === 'boolean'
	) {
		return String(normalized);
	}

	return JSON.stringify(normalized);
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
	if (value === null || value === undefined) {
		return [];
	}

	return Array.isArray(value) ? value : [value];
}

function getExpressID(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (
		value &&
		typeof value === 'object' &&
		'value' in value &&
		typeof (value as { value?: unknown }).value === 'number'
	) {
		return (value as { value: number }).value;
	}

	if (
		value &&
		typeof value === 'object' &&
		'expressID' in value &&
		typeof (value as { expressID?: unknown }).expressID === 'number'
	) {
		return (value as { expressID: number }).expressID;
	}

	return null;
}

function getExpressIDs(value: unknown): number[] {
	return toArray(value)
		.map((entry) => getExpressID(entry))
		.filter((entry): entry is number => entry !== null);
}

function collectPropertyValues(property: Record<string, unknown>): IfcPropertyValue[] {
	const name =
		toOptionalDisplayValue(property.Name) ?? `Property #${property.expressID ?? 'unknown'}`;
	const skipKeys = new Set([
		'expressID',
		'type',
		'Name',
		'Description',
		'GlobalId',
		'OwnerHistory',
		'HasExternalReferences',
		'PartOfComplex',
		'Unit'
	]);
	const properties: IfcPropertyValue[] = [];

	for (const [key, rawValue] of Object.entries(property)) {
		if (skipKeys.has(key)) {
			continue;
		}

		if (rawValue === null || rawValue === undefined || rawValue === '') {
			continue;
		}

		properties.push({
			name: key === 'NominalValue' ? name : `${name}.${key}`,
			value: toDisplayValue(rawValue)
		});
	}

	if (properties.length === 0) {
		properties.push({
			name,
			value: '-'
		});
	}

	return properties;
}

function toPropertyGroup(group: Record<string, unknown>): IfcPropertyGroup | null {
	const groupName =
		toOptionalDisplayValue(group.Name) ?? `PropertySet #${group.expressID ?? 'unknown'}`;
	const rawProperties = [
		...(Array.isArray(group.HasProperties) ? group.HasProperties : []),
		...(Array.isArray(group.Quantities) ? group.Quantities : [])
	] as Record<string, unknown>[];
	const properties = rawProperties.flatMap((property) => collectPropertyValues(property));

	if (properties.length === 0) {
		return null;
	}

	return {
		name: groupName,
		properties
	};
}

function mergePropertyGroups(groups: Record<string, unknown>[]): IfcPropertyGroup[] {
	return groups
		.map((group) => toPropertyGroup(group))
		.filter((group): group is IfcPropertyGroup => group !== null);
}

function getLineRecord(
	api: IfcAPI,
	modelID: number,
	expressID: number,
	recursive = false,
	inverse = false,
	inversePropKey?: string
): Record<string, unknown> {
	return api.GetLine(modelID, expressID, recursive, inverse, inversePropKey ?? null) as Record<
		string,
		unknown
	>;
}

function getInverseRelationIds(
	api: IfcAPI,
	modelID: number,
	expressID: number,
	inverseKey: string
): number[] {
	const item = getLineRecord(api, modelID, expressID, false, true, inverseKey);
	return getExpressIDs(item[inverseKey]);
}

function getRelatedDefinitionIds(
	api: IfcAPI,
	modelID: number,
	relationIds: number[],
	relatingKey: string
): number[] {
	const relatedIds = new Set<number>();

	for (const relationId of relationIds) {
		const relation = getLineRecord(api, modelID, relationId, false, false);

		for (const definitionId of getExpressIDs(relation[relatingKey])) {
			relatedIds.add(definitionId);
		}
	}

	return Array.from(relatedIds);
}

function getPropertySetDefinitionsFromTypeObject(
	api: IfcAPI,
	modelID: number,
	typeObjectId: number
): number[] {
	const typeObject = getLineRecord(api, modelID, typeObjectId, false, false);
	return getExpressIDs(typeObject.HasPropertySets);
}

function getDirectPropertySetIds(api: IfcAPI, modelID: number, expressID: number): number[] {
	const relationIds = getInverseRelationIds(api, modelID, expressID, 'IsDefinedBy');
	return getRelatedDefinitionIds(api, modelID, relationIds, 'RelatingPropertyDefinition');
}

function getTypeObjectIds(api: IfcAPI, modelID: number, expressID: number): number[] {
	const schema = api.GetModelSchema(modelID);

	if (schema === 'IFC2X3') {
		const relationIds = getInverseRelationIds(api, modelID, expressID, 'IsDefinedBy');
		return getRelatedDefinitionIds(api, modelID, relationIds, 'RelatingType');
	}

	const relationIds = getInverseRelationIds(api, modelID, expressID, 'IsTypedBy');
	return getRelatedDefinitionIds(api, modelID, relationIds, 'RelatingType');
}

async function extractPropertyGroups(
	api: IfcAPI,
	modelID: number,
	expressID: number
): Promise<IfcPropertyGroup[]> {
	const propertySetIds = new Set<number>(getDirectPropertySetIds(api, modelID, expressID));
	const typeObjectIds = getTypeObjectIds(api, modelID, expressID);

	for (const typeObjectId of typeObjectIds) {
		for (const propertySetId of getPropertySetDefinitionsFromTypeObject(
			api,
			modelID,
			typeObjectId
		)) {
			propertySetIds.add(propertySetId);
		}
	}

	const propertyGroups = Array.from(propertySetIds).map((propertySetId) =>
		getLineRecord(api, modelID, propertySetId, true, false)
	);

	return mergePropertyGroups(propertyGroups);
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
		propertyGroups: await extractPropertyGroups(api, modelID, expressID),
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
