import type { MemoryResourceEntry, ScenePackage } from './gltf-builder';

type MaprayModule = typeof import('@mapray/mapray-js').default;
type MaprayResourceInstance = InstanceType<MaprayModule['Resource']>;

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function resolvePath(fromPath: string, targetPath: string): string {
	const baseUrl = new URL(fromPath, 'memory://ifc/');
	const resolvedUrl = new URL(targetPath, baseUrl);
	return resolvedUrl.pathname.replace(/^\//, '');
}

export function createMemoryResource(
	mapray: MaprayModule,
	scenePackage: ScenePackage
): MaprayResourceInstance {
	class MemoryResource extends mapray.Resource {
		readonly #resources: Record<string, MemoryResourceEntry>;
		readonly #path: string;

		constructor(resources: Record<string, MemoryResourceEntry>, path: string) {
			super();
			this.#resources = resources;
			this.#path = path;
		}

		async load(options: { type?: number } = {}): Promise<unknown> {
			return this.#loadPath(this.#path, options.type ?? mapray.Resource.Type.JSON);
		}

		loadSubResourceSupported(): boolean {
			return true;
		}

		async loadSubResource(subPath: string, options: { type?: number } = {}): Promise<unknown> {
			return this.#loadPath(
				resolvePath(this.#path, subPath),
				options.type ?? mapray.Resource.Type.JSON
			);
		}

		resolveResourceSupported(): boolean {
			return true;
		}

		resolveResource(subPath: string) {
			return new MemoryResource(this.#resources, resolvePath(this.#path, subPath));
		}

		toString(): string {
			return `MemoryResource(${this.#path})`;
		}

		async #loadPath(path: string, type: number): Promise<unknown> {
			const entry = this.#resources[path];

			if (!entry) {
				throw new Error(`In-memory resource not found: ${path}`);
			}

			if (type === mapray.Resource.Type.BINARY) {
				if (!entry.binary) {
					throw new Error(`Binary payload not found: ${path}`);
				}

				return entry.binary.slice(0);
			}

			if (type === mapray.Resource.Type.JSON || type === mapray.Resource.Type.TEXT) {
				if (!entry.json) {
					throw new Error(`JSON payload not found: ${path}`);
				}

				return type === mapray.Resource.Type.TEXT
					? JSON.stringify(entry.json)
					: cloneJson(entry.json);
			}

			throw new Error(`Unsupported resource type for memory resource: ${type}`);
		}
	}

	return new MemoryResource(scenePackage.resources, scenePackage.entryPath);
}
