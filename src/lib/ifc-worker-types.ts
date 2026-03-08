import type { SceneChunk, ScenePackage } from './gltf-builder';
import type { ExtractedModelStats, IfcElementMetadata } from './ifc-loader';

export interface IfcProcessingMetrics {
	parseIfcMs: number;
	gltfTransformMs: number;
	totalMs: number;
}

export interface IfcWorkerLoadRequest {
	type: 'load-ifc';
	requestId: number;
	data: ArrayBuffer;
	wasmPath?: string;
}

export interface IfcWorkerProgressMessage {
	type: 'progress';
	requestId: number;
	message: string;
}

export interface IfcWorkerSuccessMessage {
	type: 'success';
	requestId: number;
	scenePackage: ScenePackage;
	stats: ExtractedModelStats;
	elements: IfcElementMetadata[];
	chunks: SceneChunk[];
	metrics: IfcProcessingMetrics;
}

export interface IfcWorkerErrorMessage {
	type: 'error';
	requestId: number;
	error: string;
}

export type IfcWorkerRequest = IfcWorkerLoadRequest;

export type IfcWorkerResponse =
	| IfcWorkerProgressMessage
	| IfcWorkerSuccessMessage
	| IfcWorkerErrorMessage;
